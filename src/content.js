/**
 * Roblox Gamepass Creator - Content Script
 * Modern, performance-optimized extension for managing Roblox gamepasses
 */

(function() {
  if (window.robloxGamepassCreatorLoaded) return;
  window.robloxGamepassCreatorLoaded = true;

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================

  const DEFAULT_PRESETS = [2, 5, 10, 15, 25, 50, 75, 100, 150, 200, 250, 350, 500, 750, 1000, 2500, 3500, 5000, 7500, 10000];
  const CACHE_DURATION = 30000; // 30 seconds
  const REQUEST_TIMEOUT = 15000; // 15 seconds

  class StateManager {
    constructor() {
      this.userData = {
        userId: null,
        username: null,
        displayName: null,
        csrfToken: null
      };

      this.uiState = {
        isOpen: false,
        currentSection: 'main',
        currentTab: 'create',
        windowPosition: null
      };

      this.cache = {
        targetUniverse: null,
        gamepasses: [],
        selectedPassIds: new Set(),
        cacheTime: 0,
        questionnaireCache: null
      };

      this.settings = {
        presets: [...DEFAULT_PRESETS],
        isRegionalPricingEnabled: false
      };

      this.operations = {
        isRunning: false,
        currentAction: null,
        progress: 0,
        total: 0,
        results: [],
        logs: []
      };

      this.observers = new Map();
      this.abortControllers = new Map();
    }

    async load() {
      return new Promise((resolve) => {
        chrome.storage.local.get(['gamepassCreatorState'], (result) => {
          if (result.gamepassCreatorState) {
            const saved = result.gamepassCreatorState;
            Object.assign(this.userData, saved.userData || {});
            Object.assign(this.uiState, saved.uiState || {});
            Object.assign(this.settings, saved.settings || {});
            if (saved.cache?.selectedPassIds) {
              this.cache.selectedPassIds = new Set(saved.cache.selectedPassIds);
            }
          }
          resolve();
        });
      });
    }

    async save() {
      return new Promise((resolve) => {
        const state = {
          userData: this.userData,
          uiState: this.uiState,
          settings: this.settings,
          cache: {
            ...this.cache,
            selectedPassIds: Array.from(this.cache.selectedPassIds)
          }
        };
        chrome.storage.local.set({ gamepassCreatorState: state }, resolve);
      });
    }

    clearOperations() {
      this.operations = {
        isRunning: false,
        currentAction: null,
        progress: 0,
        total: 0,
        results: [],
        logs: []
      };
    }

    cleanup() {
      this.abortControllers.forEach(controller => controller.abort());
      this.abortControllers.clear();
      this.observers.forEach(observer => observer.disconnect());
      this.observers.clear();
    }
  }

  // ============================================================================
  // API UTILITIES
  // ============================================================================

  class RobloxAPI {
    constructor(state) {
      this.state = state;
    }

    async fetch(url, options = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      
      try {
        if (!options.headers) options.headers = {};
        if (this.state.userData.csrfToken) {
          options.headers['x-csrf-token'] = this.state.userData.csrfToken;
        }
        options.credentials = 'include';
        options.signal = controller.signal;

        let response = await fetch(url, options);

        if (response.status === 403) {
          const newToken = response.headers.get('x-csrf-token');
          if (newToken) {
            this.state.userData.csrfToken = newToken;
            options.headers['x-csrf-token'] = newToken;
            response = await fetch(url, options);
          }
        }

        return response;
      } finally {
        clearTimeout(timeout);
      }
    }

    async getErrorMessage(response) {
      try {
        const data = await response.clone().json();
        if (data.errorMessage) return data.errorMessage;
        if (data.errors?.length > 0) return data.errors[0].message;
        if (data.message) return data.message;
      } catch (e) {
        // Silent fail
      }
      return `HTTP ${response.status}`;
    }

    async ensureUniverseLinked() {
      if (this.state.cache.targetUniverse) return this.state.cache.targetUniverse;

      const gamesResp = await this.fetch(
        `https://games.roblox.com/v2/users/${this.state.userData.userId}/games?sortOrder=Asc&limit=10`
      );
      if (!gamesResp.ok) throw new Error(await this.getErrorMessage(gamesResp));

      const games = await gamesResp.json();
      if (!games.data?.length) throw new Error('No games found in your account');

      const game = games.data[0];
      const univResp = await this.fetch(
        `https://apis.roblox.com/universes/v1/places/${game.rootPlace.id}/universe`
      );
      if (!univResp.ok) throw new Error(await this.getErrorMessage(univResp));

      const univData = await univResp.json();
      this.state.cache.targetUniverse = univData.universeId;
      await this.state.save();

      return this.state.cache.targetUniverse;
    }

    async getGamepasses() {
      const now = Date.now();
      if (this.state.cache.gamepasses.length > 0 && (now - this.state.cache.cacheTime) < CACHE_DURATION) {
        return this.state.cache.gamepasses;
      }

      const universeId = await this.ensureUniverseLinked();
      const resp = await this.fetch(
        `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes?passView=Full&pageSize=100`
      );

      if (!resp.ok) throw new Error(await this.getErrorMessage(resp));

      const data = await resp.json();
      this.state.cache.gamepasses = data.gamePasses || [];
      this.state.cache.cacheTime = now;

      return this.state.cache.gamepasses;
    }

    async createGamepass(name) {
      const universeId = await this.ensureUniverseLinked();
      const form = new FormData();
      form.append('name', name.toString());
      form.append('universeId', universeId.toString());

      const resp = await this.fetch(
        `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes`,
        { method: 'POST', body: form }
      );

      if (!resp.ok) throw new Error(await this.getErrorMessage(resp));
      const data = await resp.json();
      return data.gamePassId;
    }

    async updateGamepass(passId, updates) {
      const universeId = await this.ensureUniverseLinked();
      const form = new FormData();
      Object.entries(updates).forEach(([key, value]) => {
        form.append(key, value.toString());
      });

      const resp = await this.fetch(
        `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes/${passId}`,
        { method: 'PATCH', body: form }
      );

      if (!resp.ok) throw new Error(await this.getErrorMessage(resp));
      return true;
    }
  }

  // ============================================================================
  // UI BUILDER
  // ============================================================================

  class UIBuilder {
    static get STYLES() {
      return `
        :host {
          --color-bg-primary: #0d0d0d;
          --color-bg-secondary: rgba(255, 255, 255, 0.04);
          --color-bg-tertiary: rgba(255, 255, 255, 0.08);
          --color-bg-hover: rgba(255, 255, 255, 0.12);
          --color-border: rgba(255, 255, 255, 0.08);
          --color-border-strong: rgba(255, 255, 255, 0.2);
          --color-text-primary: #ffffff;
          --color-text-secondary: #888888;
          --color-accent: #3b82f6;
          --color-success: #10b981;
          --color-error: #ef4444;
          --color-warning: #f59e0b;
          --radius-sm: 6px;
          --radius-md: 12px;
          --radius-lg: 16px;
          --shadow-sm: 0 4px 12px rgba(0, 0, 0, 0.15);
          --shadow-lg: 0 30px 60px rgba(0, 0, 0, 0.7);
          --transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          z-index: 9999999;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
        }

        :host(.light-mode) {
          --color-bg-primary: #f5f5f5;
          --color-bg-secondary: rgba(0, 0, 0, 0.04);
          --color-bg-tertiary: rgba(0, 0, 0, 0.08);
          --color-bg-hover: rgba(0, 0, 0, 0.08);
          --color-border: rgba(0, 0, 0, 0.1);
          --color-border-strong: rgba(0, 0, 0, 0.2);
          --color-text-primary: #000000;
          --color-text-secondary: #666666;
          --shadow-lg: 0 30px 60px rgba(0, 0, 0, 0.15);
        }

        * {
          box-sizing: border-box;
        }

        .widget {
          position: fixed;
          width: 540px;
          max-height: 90vh;
          background: var(--color-bg-primary);
          backdrop-filter: blur(24px);
          border-radius: var(--radius-lg);
          border: 1px solid var(--color-border);
          box-shadow: var(--shadow-lg);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1), transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
          opacity: 0;
          transform: translate(-50%, -48%) scale(0.95);
          pointer-events: none;
        }

        .widget.open {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
          pointer-events: all;
        }

        .header {
          padding: 16px 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid var(--color-border);
          background: rgba(255, 255, 255, 0.02);
          cursor: grab;
          user-select: none;
        }

        .header:active {
          cursor: grabbing;
        }

        .header-title {
          font-size: 14px;
          font-weight: 700;
          letter-spacing: 0.05em;
          color: var(--color-text-secondary);
          text-transform: uppercase;
          margin: 0;
        }

        .header-actions {
          display: flex;
          gap: 8px;
        }

        .icon-button {
          background: transparent;
          border: none;
          color: var(--color-text-secondary);
          width: 32px;
          height: 32px;
          border-radius: var(--radius-sm);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: var(--transition);
          padding: 0;
        }

        .icon-button:hover {
          background: var(--color-bg-hover);
          color: var(--color-text-primary);
        }

        .icon-button svg {
          width: 16px;
          height: 16px;
        }

        .content {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .content::-webkit-scrollbar {
          width: 6px;
        }

        .content::-webkit-scrollbar-track {
          background: transparent;
        }

        .content::-webkit-scrollbar-thumb {
          background: var(--color-border-strong);
          border-radius: 3px;
        }

        /* Tabs */
        .tab-container {
          display: flex;
          gap: 8px;
          border-bottom: 2px solid var(--color-border);
          padding-bottom: 12px;
          margin-bottom: 8px;
        }

        .tab-button {
          background: transparent;
          border: none;
          padding: 8px 12px;
          font-size: 12px;
          font-weight: 600;
          color: var(--color-text-secondary);
          cursor: pointer;
          transition: var(--transition);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          border-bottom: 2px solid transparent;
          margin-bottom: -14px;
          font-family: inherit;
        }

        .tab-button:hover {
          color: var(--color-text-primary);
        }

        .tab-button.active {
          color: var(--color-accent);
          border-bottom-color: var(--color-accent);
        }

        .tab-content {
          display: none;
        }

        .tab-content.active {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        /* Buttons */
        .button {
          height: 40px;
          padding: 0 16px;
          border-radius: var(--radius-sm);
          border: 1px solid var(--color-border);
          background: var(--color-bg-secondary);
          color: var(--color-text-primary);
          font-weight: 600;
          font-size: 13px;
          cursor: pointer;
          transition: var(--transition);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font-family: inherit;
        }

        .button:hover {
          background: var(--color-bg-tertiary);
          border-color: var(--color-border-strong);
        }

        .button:active {
          transform: scale(0.98);
        }

        .button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .button.primary {
          background: var(--color-accent);
          color: white;
          border: none;
        }

        .button.primary:hover {
          filter: brightness(1.1);
        }

        .button.danger {
          color: var(--color-error);
          border-color: rgba(239, 68, 68, 0.2);
        }

        .button.danger:hover {
          background: rgba(239, 68, 68, 0.1);
        }

        .button.success {
          color: var(--color-success);
          border-color: rgba(16, 185, 129, 0.2);
        }

        .button svg {
          width: 14px;
          height: 14px;
          opacity: 0.7;
        }

        /* Input */
        .input-field {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .input-label {
          font-size: 11px;
          font-weight: 700;
          color: var(--color-text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        input[type="text"],
        input[type="number"],
        textarea,
        select {
          width: 100%;
          padding: 10px 12px;
          border-radius: var(--radius-sm);
          border: 1px solid var(--color-border);
          background: var(--color-bg-secondary);
          color: var(--color-text-primary);
          font-family: inherit;
          font-size: 13px;
          transition: var(--transition);
        }

        input[type="text"]:focus,
        input[type="number"]:focus,
        textarea:focus,
        select:focus {
          outline: none;
          border-color: var(--color-accent);
          background: var(--color-bg-tertiary);
        }

        textarea {
          min-height: 80px;
          resize: none;
          font-size: 12px;
          line-height: 1.5;
        }

        /* Card */
        .card {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .card-title {
          font-size: 12px;
          font-weight: 700;
          color: var(--color-text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin: 0;
        }

        /* Lists */
        .list-container {
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg-secondary);
          max-height: 400px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
        }

        .list-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px;
          border-bottom: 1px solid var(--color-border);
          transition: var(--transition);
        }

        .list-item:last-child {
          border-bottom: none;
        }

        .list-item:hover {
          background: var(--color-bg-hover);
        }

        .list-item-checkbox {
          width: 18px;
          height: 18px;
          cursor: pointer;
          accent-color: var(--color-accent);
        }

        .list-item-thumbnail {
          width: 40px;
          height: 40px;
          border-radius: var(--radius-sm);
          background: var(--color-bg-primary);
          border: 1px solid var(--color-border);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          overflow: hidden;
        }

        .list-item-thumbnail img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .list-item-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
        }

        .list-item-title {
          font-weight: 600;
          font-size: 12px;
          color: var(--color-text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .list-item-meta {
          font-size: 10px;
          color: var(--color-text-secondary);
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .list-item-badge {
          font-size: 9px;
          font-weight: 700;
          padding: 3px 6px;
          border-radius: 3px;
          text-transform: uppercase;
          width: fit-content;
        }

        .list-item-badge.sale {
          background: rgba(16, 185, 129, 0.15);
          color: var(--color-success);
        }

        .list-item-badge.off-sale {
          background: rgba(239, 68, 68, 0.15);
          color: var(--color-error);
        }

        .list-item-price {
          font-weight: 600;
          font-size: 12px;
          color: var(--color-text-primary);
          min-width: 60px;
          text-align: right;
        }

        .list-item-actions {
          display: flex;
          gap: 4px;
        }

        .list-item-action {
          width: 28px;
          height: 28px;
          padding: 0;
          border-radius: 4px;
          border: 1px solid var(--color-border);
          background: var(--color-bg-primary);
          color: var(--color-text-secondary);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: var(--transition);
          font-family: inherit;
        }

        .list-item-action:hover {
          background: var(--color-bg-hover);
          border-color: var(--color-border-strong);
          color: var(--color-text-primary);
        }

        .list-item-action svg {
          width: 13px;
          height: 13px;
        }

        /* Progress */
        .progress-container {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .progress-bar {
          height: 4px;
          background: var(--color-bg-secondary);
          border-radius: 2px;
          overflow: hidden;
          border: 1px solid var(--color-border);
        }

        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--color-accent), var(--color-success));
          width: 0%;
          transition: width 0.3s ease;
        }

        .progress-stats {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          font-weight: 600;
          color: var(--color-text-secondary);
          text-transform: uppercase;
        }

        .log-container {
          background: var(--color-bg-secondary);
          border-radius: var(--radius-md);
          padding: 12px;
          height: 160px;
          overflow-y: auto;
          font-size: 11px;
          border: 1px solid var(--color-border);
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .log-entry {
          display: flex;
          gap: 8px;
          color: var(--color-text-secondary);
          line-height: 1.4;
        }

        .log-entry.success {
          color: var(--color-success);
        }

        .log-entry.error {
          color: var(--color-error);
        }

        .log-entry.warning {
          color: var(--color-warning);
        }

        .log-entry svg {
          width: 12px;
          height: 12px;
          flex-shrink: 0;
          margin-top: 2px;
        }

        /* Modal */
        .overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.3s;
        }

        .overlay.active {
          opacity: 1;
          pointer-events: all;
        }

        .modal {
          background: var(--color-bg-primary);
          border: 1px solid var(--color-border);
          padding: 24px;
          border-radius: var(--radius-lg);
          max-width: 320px;
          text-align: center;
          box-shadow: var(--shadow-lg);
        }

        .modal-title {
          margin: 0 0 12px;
          font-size: 16px;
          font-weight: 700;
        }

        .modal-content {
          color: var(--color-text-secondary);
          font-size: 13px;
          margin: 0 0 24px;
          line-height: 1.5;
        }

        .modal-actions {
          display: flex;
          gap: 12px;
        }

        .modal-actions .button {
          flex: 1;
        }

        /* Empty State */
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          min-height: 150px;
          color: var(--color-text-secondary);
          font-size: 12px;
        }

        /* Loading State */
        .loading-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          min-height: 150px;
          justify-content: center;
        }

        .spinner {
          width: 24px;
          height: 24px;
          border: 2px solid var(--color-border);
          border-top-color: var(--color-accent);
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        /* Notification */
        .notification {
          position: fixed;
          bottom: 24px;
          right: 24px;
          background: var(--color-text-primary);
          color: var(--color-bg-primary);
          padding: 12px 16px;
          border-radius: var(--radius-md);
          font-size: 12px;
          font-weight: 600;
          z-index: 10001;
          animation: slideInUp 0.3s ease-out;
          box-shadow: var(--shadow-lg);
        }

        .notification.error {
          background: var(--color-error);
          color: white;
        }

        .notification.success {
          background: var(--color-success);
          color: white;
        }

        @keyframes slideInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .hidden {
          display: none !important;
        }

        /* Responsive */
        @media (max-width: 640px) {
          .widget {
            width: 90vw;
            max-width: 500px;
          }
        }
      `;
    }

    static get ICONS() {
      return {
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
        settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
        plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
        bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>',
        trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>',
        x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
        refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36"></path></svg>',
        search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
        edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
        copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>',
        clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>',
        alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>'
      };
    }
  }

  // ============================================================================
  // WIDGET CONTROLLER
  // ============================================================================

  class WidgetController {
    constructor() {
      this.state = new StateManager();
      this.api = null;
      this.shadowRoot = null;
      this.host = null;
      this.elements = {};
      this.isDragging = false;
      this.dragOffset = { x: 0, y: 0 };
    }

    async initialize() {
      await this.state.load();
      this.extractUserData();
      this.api = new RobloxAPI(this.state);
      
      this.createUI();
      this.setupEventListeners();
      this.syncTheme();
      this.injectNavbarButton();
      
      if (this.state.uiState.isOpen) {
        this.openWidget();
      }
    }

    extractUserData() {
      const userDataMeta = document.querySelector('meta[name="user-data"]');
      if (userDataMeta) {
        this.state.userData.userId = userDataMeta.getAttribute('data-userid');
        this.state.userData.username = userDataMeta.getAttribute('data-name');
        this.state.userData.displayName = userDataMeta.getAttribute('data-displayname');
      }
      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      if (csrfMeta) {
        this.state.userData.csrfToken = csrfMeta.getAttribute('data-token');
      }
    }

    createUI() {
      this.host = document.createElement('div');
      this.host.id = 'roblox-gamepass-creator-host';
      document.body.appendChild(this.host);
      this.shadowRoot = this.host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = UIBuilder.STYLES;
      this.shadowRoot.appendChild(style);

      const container = document.createElement('div');
      container.innerHTML = this.buildHTML();
      this.shadowRoot.appendChild(container);

      this.elements = {
        widget: this.shadowRoot.querySelector('.widget'),
        header: this.shadowRoot.querySelector('.header'),
        headerTitle: this.shadowRoot.querySelector('.header-title'),
        closeBtn: this.shadowRoot.querySelector('[data-action="close"]'),
        settingsBtn: this.shadowRoot.querySelector('[data-action="settings"]'),
        tabButtons: this.shadowRoot.querySelectorAll('.tab-button'),
        tabContents: this.shadowRoot.querySelectorAll('.tab-content')
      };
    }

    buildHTML() {
      const icons = UIBuilder.ICONS;
      return `
        <div class="widget">
          <div class="header">
            <h1 class="header-title">Gamepass Creator</h1>
            <div class="header-actions">
              <button class="icon-button" data-action="settings" title="Settings">${icons.settings}</button>
              <button class="icon-button" data-action="close" title="Close">${icons.close}</button>
            </div>
          </div>

          <div class="content">
            <!-- Tabs -->
            <div class="tab-container">
              <button class="tab-button active" data-tab="create">Create</button>
              <button class="tab-button" data-tab="manage">Manage</button>
              <button class="tab-button" data-tab="settings">Settings</button>
            </div>

            <!-- Create Tab -->
            <div class="tab-content active" data-tab="create">
              <div class="card">
                <h3 class="card-title">Quick Create</h3>
                <button class="button primary">${icons.bolt} Create from Presets</button>
                <button class="button">${icons.plus} Custom Amount</button>
              </div>

              <div class="card">
                <h3 class="card-title">Utilities</h3>
                <button class="button">${icons.clipboard} Questionnaire</button>
                <button class="button danger">${icons.trash} Wipe All Passes</button>
              </div>
            </div>

            <!-- Manage Tab -->
            <div class="tab-content" data-tab="manage">
              <div class="card">
                <div style="display: flex; gap: 8px; align-items: center;">
                  <div style="flex: 1;">${icons.search}</div>
                  <input type="text" placeholder="Search by name or ID..." style="flex: 1; border: none; background: transparent;">
                </div>
              </div>

              <div class="list-container">
                <div class="empty-state">
                  <span>No gamepasses yet</span>
                </div>
              </div>
            </div>

            <!-- Settings Tab -->
            <div class="tab-content" data-tab="settings">
              <div class="card">
                <p class="card-title">Presets</p>
                <textarea placeholder="2, 5, 10, 25..."></textarea>
                <button class="button" style="font-size: 11px;">Reset to Defaults</button>
              </div>

              <div class="card">
                <button class="button primary">Save Changes</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Modals -->
        <div class="overlay" data-modal="confirm">
          <div class="modal">
            <h3 class="modal-title">Are you sure?</h3>
            <p class="modal-content">This will remove all gamepasses from sale. This action cannot be reversed.</p>
            <div class="modal-actions">
              <button class="button" data-action="cancel">Cancel</button>
              <button class="button danger" data-action="confirm">Wipe All</button>
            </div>
          </div>
        </div>
      `;
    }

    setupEventListeners() {
      // Header drag
      this.elements.header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.icon-button')) return;
        this.startDrag(e);
      });

      document.addEventListener('mousemove', (e) => this.onDrag(e));
      document.addEventListener('mouseup', (e) => this.endDrag(e));

      // Buttons
      this.elements.closeBtn.addEventListener('click', () => this.toggleWidget());
      this.elements.settingsBtn.addEventListener('click', () => this.switchTab('settings'));

      // Tabs
      this.elements.tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          const tab = btn.dataset.tab;
          this.switchTab(tab);
        });
      });

      // Theme observer
      const themeObserver = new MutationObserver(() => this.syncTheme());
      this.state.observers.set('theme', themeObserver);
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    startDrag(e) {
      this.isDragging = true;
      const rect = this.elements.widget.getBoundingClientRect();
      this.dragOffset.x = e.clientX - rect.left;
      this.dragOffset.y = e.clientY - rect.top;
      this.elements.widget.style.transition = 'none';
    }

    onDrag(e) {
      if (!this.isDragging) return;
      this.elements.widget.style.left = `${e.clientX - this.dragOffset.x}px`;
      this.elements.widget.style.top = `${e.clientY - this.dragOffset.y}px`;
      this.elements.widget.style.transform = 'none';
    }

    endDrag() {
      if (!this.isDragging) return;
      this.isDragging = false;
      this.elements.widget.style.transition = 'opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1), transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
      
      const rect = this.elements.widget.getBoundingClientRect();
      this.state.uiState.windowPosition = { x: rect.left, y: rect.top };
      this.state.save();
    }

    switchTab(tabName) {
      this.elements.tabButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
      });

      this.elements.tabContents.forEach(content => {
        content.classList.toggle('active', content.dataset.tab === tabName);
      });

      this.state.uiState.currentTab = tabName;
      this.state.save();
    }

    syncTheme() {
      const isDark = document.body.classList.contains('dark-theme');
      const isLight = !isDark || document.body.classList.contains('light-theme');
      
      this.host.classList.toggle('light-mode', isLight);
    }

    injectNavbarButton() {
      if (!this.state.userData.userId) return;
      if (document.getElementById('rbx-gamepass-creator-nav')) return;

      const navbar = document.querySelector('.nav.navbar-right.rbx-navbar-icon-group');
      if (!navbar) return;

      const item = document.createElement('li');
      item.id = 'rbx-gamepass-creator-nav';
      item.className = 'navbar-icon-item';
      item.innerHTML = `
        <button type="button" class="rbx-menu-item" style="
          background: rgba(255, 255, 255, 0.08);
          color: #fff;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          padding: 0 12px;
          height: 28px;
          margin: 6px 4px;
          font-weight: 600;
          font-size: 12px;
          cursor: pointer;
          font-family: inherit;
          transition: 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
        ">
          Create Passes
        </button>
      `;

      item.querySelector('button').addEventListener('click', () => this.toggleWidget());
      navbar.appendChild(item);
    }

    toggleWidget() {
      this.state.uiState.isOpen = !this.state.uiState.isOpen;
      this.state.save();
      
      if (this.state.uiState.isOpen) {
        this.openWidget();
      } else {
        this.closeWidget();
      }
    }

    openWidget() {
      const position = this.state.uiState.windowPosition || { x: window.innerWidth / 2 - 270, y: window.innerHeight / 2 - 300 };
      this.elements.widget.style.left = `${position.x}px`;
      this.elements.widget.style.top = `${position.y}px`;
      this.elements.widget.classList.add('open');
    }

    closeWidget() {
      this.elements.widget.classList.remove('open');
    }

    showNotification(message, type = 'success') {
      const notification = document.createElement('div');
      notification.className = `notification ${type}`;
      notification.textContent = message;
      this.shadowRoot.appendChild(notification);

      setTimeout(() => notification.remove(), 3000);
    }

    destroy() {
      this.state.cleanup();
      if (this.host) this.host.remove();
    }
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  let widget;

  function waitForDOM() {
    if (document.body && window.location.hostname === 'www.roblox.com') {
      widget = new WidgetController();
      widget.initialize();
    } else if (!document.body) {
      setTimeout(waitForDOM, 100);
    }
  }

  waitForDOM();

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (widget) widget.destroy();
  });
})();
