// Discord Rich Presence Plugin for Audion

(function () {
  "use strict";

  const DiscordRPC = {
    name: "Discord Rich Presence",

    defaultSettings: {
      enabled: true,
      showProgress: true,
      updateInterval: 15000,
      line1Left: "track_title",
      line1Right: "none",
      line1CustomLeft: "",
      line1CustomRight: "",
      line2Left: "artist",
      line2Right: "none",
      line2CustomLeft: "",
      line2CustomRight: "",
      line3Left: "album",
      line3Right: "none",
      line3CustomLeft: "",
      line3CustomRight: "",
      appNameLeft: "none",
      appNameRight: "none",
      appNameCustomLeft: "",
      appNameCustomRight: "",
      statusDisplayType: "details",
      useLocalCovers: false,
      useOnlineCovers: false,
      coverPriority: "local",
      activityTimeoutEnabled: true,
      activityTimeoutTime: 600000,
      showPauseIcon: true,

    },

    settings: null,
    isConnected: false,
    currentTrack: null,
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    updateTimeout: null,
    activityClearTimeout: null,
    reconnectTimeout: null,
    reconnectAttempts: 0,
    coverCache: new Map(),   // trackId -> resolved cover URL
    MAX_COVER_CACHE_SIZE: 50,
    isSettingsOpen: false,
    api: null,
    tempSettings: null,
    connectionStatusInterval: null,
    lastProgressUpdate: 0,
    lastTrackId: null,
    lastPlayingState: null,
    lastTime: 0,

    _updatePresenceLock: false,

    // Initialize plugin: load settings, register events, connect to Discord
    async init(api) {
      this.api = api;
      this.settings = { ...this.defaultSettings };

      this.lastProgressUpdate = Date.now();

      await this.loadSettings();

      this.injectStyles();
      this.createSettingsModal();
      this.createMenuButton();

      api.on("trackChange", (data) => this.handleTrackChange(data), this.name);
      api.on(
        "playStateChange",
        (data) => this.handlePlaybackState(data),
        this.name,
      );
      api.on("timeUpdate", (data) => this.handleTimeUpdate(data), this.name);
      api.on("seeked", (data) => this.handleSeeked(data), this.name);

      if (this.settings.enabled) {
        this.connect();
      }
    },

    // Load persisted settings from storage
    async loadSettings() {
      if (!this.api?.storage?.get) return;

      try {
        const saved = await this.api.storage.get("settings");
        if (saved) {
          this.settings = { ...this.defaultSettings, ...saved };
        }
      } catch (err) {
        console.error("[Discord RPC] Error loading settings:", err);
      }
    },

    // Save current settings to persistent storage
    async saveSettings() {
      if (!this.api?.storage?.set) {
        if (this.isSettingsOpen) {
          this.showStorageWarning();
        }
        return false;
      }

      try {
        await this.api.storage.set("settings", this.settings);
        return true;
      } catch (err) {
        console.error("[Discord RPC] Error saving settings:", err);
        if (this.isSettingsOpen) {
          this.showStorageWarning();
        }
        return false;
      }
    },

    // Show temporary warning when storage is unavailable
    showStorageWarning() {
      const statusText = document.querySelector(".drpc-status-text");
      if (statusText) {
        const originalText = statusText.textContent;
        statusText.textContent = "Storage unavailable - settings won't persist";
        statusText.style.color = "#ffc107";
        setTimeout(() => {
          statusText.textContent = originalText;
          statusText.style.color = "";
        }, 3000);
      }
    },

    // Apply temp settings, handle connect/disconnect
    async applySettings() {
      this.settings = { ...this.tempSettings };

      const needsReconnect = !this.isConnected && this.settings.enabled;
      const needsDisconnect = this.isConnected && !this.settings.enabled;

      if (needsReconnect) {
        await this.connect();
      } else if (needsDisconnect) {
        await this.clearPresence();
        await this.disconnect();
      } else if (this.isConnected && this.settings.enabled) {
        await this.updatePresence(true);
      }

      await this.saveSettings();
      this.updateConnectionStatus();
    },

    // Inject plugin CSS into document head
    injectStyles() {
      if (document.getElementById("drpc-styles")) return;

      const style = document.createElement("style");
      style.id = "drpc-styles";
      style.textContent = `
        #drpc-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(4px);
          z-index: 10000;
          opacity: 0;
          visibility: hidden;
          transition: opacity 0.3s ease;
        }
        #drpc-overlay.open {
          opacity: 1;
          visibility: visible;
        }

        #drpc-modal {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%) scale(0.9);
          background: var(--bg-elevated);
          border: 1px solid var(--border-color);
          border-radius: 16px;
          width: 550px;
          max-width: 90vw;
          max-height: 85vh;
          z-index: 10001;
          box-shadow: var(--shadow-lg);
          opacity: 0;
          visibility: hidden;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        #drpc-modal.open {
          opacity: 1;
          visibility: visible;
          transform: translate(-50%, -50%) scale(1);
        }

        .drpc-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 20px;
          flex-shrink: 0;
          padding: 24px 24px 0 24px;
        }
        
        .drpc-modal-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 0 24px 24px 24px;
          overscroll-behavior-y: contain;
        }
        .drpc-header h2 {
          margin: 0;
          color: var(--text-primary);
          font-size: 20px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .drpc-icon {
          color: #5865F2;
          display: inline-flex;
          align-items: center;
          position: relative;
          top: 0.5px;
        }
        .drpc-close-btn {
          background: transparent;
          border: none;
          color: var(--text-secondary);
          font-size: 20px;
          cursor: pointer;
          padding: 4px;
          transition: color 0.2s;
        }
        .drpc-close-btn:hover {
          color: var(--text-primary);
        }

        .drpc-status {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          transition: all 0.3s ease;
        }
        .drpc-status-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: var(--text-subdued);
          transition: all 0.3s ease;
        }
        .drpc-status-dot.connected {
          background: #3ba55d;
          box-shadow: 0 0 8px rgba(59, 165, 93, 0.4);
        }
        .drpc-status-dot.disconnected {
          background: #ed4245;
          box-shadow: 0 0 8px rgba(237, 66, 69, 0.4);
        }
        .drpc-status-dot.disabled {
          background: #99aab5;
        }
        .drpc-status-text {
          color: var(--text-primary);
          font-size: 14px;
          font-weight: 500;
          transition: all 0.3s ease;
        }

        .drpc-toggle-section {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px;
        }
        .drpc-toggle-label {
          display: flex;
          flex-direction: column;
          gap: 4px;
          flex: 1;
          min-width: 0;
        }
        .drpc-toggle-title {
          color: var(--text-primary);
          font-weight: 600;
          font-size: 15px;
        }
        .drpc-toggle-desc {
          color: var(--text-secondary);
          font-size: 13px;
        }

        .drpc-toggle {
          position: relative;
          width: 48px;
          height: 26px;
          flex-shrink: 0;
        }
        .drpc-toggle input {
          opacity: 0;
          width: 0;
          height: 0;
        }
        .drpc-toggle-slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: var(--bg-highlight);
          transition: 0.3s;
          border-radius: 26px;
        }
        .drpc-toggle-slider:before {
          position: absolute;
          content: "";
          height: 20px;
          width: 20px;
          left: 3px;
          bottom: 3px;
          background: white;
          transition: 0.3s;
          border-radius: 50%;
        }
        .drpc-toggle input:checked + .drpc-toggle-slider {
          background: var(--accent-primary);
        }
        .drpc-toggle input:checked + .drpc-toggle-slider:before {
          transform: translateX(22px);
        }

        .drpc-settings-container {
          transition: opacity 0.3s, filter 0.3s;
        }
        .drpc-settings-container.disabled .drpc-setting-item,
        .drpc-settings-container.disabled .drpc-section:not(:first-child) {
          opacity: 0.5;
          filter: grayscale(100%);
          pointer-events: none;
        }

        .drpc-setting-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .drpc-setting-item:last-child {
          border-bottom: none;
        }
        .drpc-setting-label {
          color: var(--text-primary);
          font-size: 14px;
          font-weight: 500;
          flex: 1;
        }
        .drpc-setting-desc {
          color: var(--text-secondary);
          font-size: 12px;
          margin-top: 4px;
        }
        .drpc-setting-text {
          flex: 1;
          min-width: 0;
        }

        .drpc-section {
          margin-bottom: 24px;
          background: var(--bg-surface);
          border-radius: 8px;
          border: 1px solid var(--border-color);
          overflow: hidden;
        }
        .drpc-section-title {
          color: var(--text-primary);
          font-size: 13px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 12px 16px 8px;
          opacity: 0.7;
        }

        .drpc-compound-format {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .drpc-compound-select {
          flex: 1;
          min-width: 0;
        }
        .drpc-compound-divider {
          color: var(--text-subdued);
          font-weight: 600;
          user-select: none;
        }

        .drpc-select, .drpc-input {
          width: 100%;
          padding: 10px 14px;
          background: var(--bg-surface);
          border: 1.5px solid rgba(255, 255, 255, 0.06);
          border-radius: 6px;
          color: var(--text-primary);
          font-size: 13px;
          transition: all 0.2s;
          font-family: inherit;
        }
        
        .drpc-select {
          cursor: pointer;
          appearance: none;
          -webkit-appearance: none;
          -moz-appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23999' d='M6 9L1 4h10z'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 12px center;
          padding-right: 36px;
        }
        
        .drpc-select:hover {
          border-color: var(--accent-primary);
          background-color: var(--bg-highlight);
        }
        
        .drpc-select:focus, .drpc-input:focus {
          outline: none;
          border-color: var(--accent-primary);
          box-shadow: 0 0 0 3px rgba(88, 101, 242, 0.1);
        }
        
        .drpc-select option {
          background: var(--bg-elevated);
          color: var(--text-primary);
          padding: 8px;
        }

        .drpc-input-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 12px 16px;
        }
        .drpc-input-group + .drpc-input-group {
          border-top: 1px solid rgba(255, 255, 255, 0.06);
        }
        .drpc-input-group label {
          color: var(--text-primary);
          font-size: 13px;
          font-weight: 500;
        }

        .drpc-range-wrapper {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .drpc-range-value {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 13px;
          color: var(--text-secondary);
        }
        .drpc-range {
          width: 100%;
          height: 6px;
          border-radius: 3px;
          background: var(--bg-highlight);
          outline: none;
          -webkit-appearance: none;
          appearance: none;
        }
        .drpc-range::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--accent-primary);
          cursor: pointer;
          transition: transform 0.2s;
        }
        .drpc-range::-webkit-slider-thumb:hover {
          transform: scale(1.2);
        }
        .drpc-range::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border: none;
          border-radius: 50%;
          background: var(--accent-primary);
          cursor: pointer;
          transition: transform 0.2s;
        }

        .drpc-preview {
          padding: 0;
          background: #1e1f22;
          border: 1px solid #2b2d31;
          border-radius: 8px;
          margin-top: 8px;
          overflow: hidden;
        }

        .drpc-preview-title {
          font-size: 11px;
          color: #b5bac1;
          margin-bottom: 0;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 12px 16px 8px;
          background: #2b2d31;
          border-bottom: 1px solid #3f4147;
        }
        
        .drpc-preview-content {
          padding: 16px;
        }
        
        .drpc-discord-card {
          background: #2b2d31;
          border-radius: 8px;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          border: 1px solid rgba(255, 255, 255, 0.05);
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
          position: relative;
        }

        .drpc-discord-app {
          font-size: 11px;
          color: #b5bac1;
          font-weight: 600;
          margin-bottom: 4px;
        }
        
        .drpc-discord-menu {
          position: absolute;
          top: 12px;
          right: 12px;
          width: 20px;
          height: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #b5bac1;
          font-size: 16px;
        }
        
        .drpc-discord-main {
          display: flex;
          gap: 12px;
        }
        
        .drpc-discord-image {
          width: 80px;
          height: 80px;
          border-radius: 8px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-size: 32px;
          position: relative;
        }
        
        .drpc-discord-image img {
          width: 100%;
          height: 100%;
          border-radius: 8px;
          object-fit: cover;
        }
        
        .drpc-discord-image.loading::after {
          content: "";
          position: absolute;
          width: 24px;
          height: 24px;
          border: 3px solid rgba(255, 255, 255, 0.3);
          border-top-color: white;
          border-radius: 50%;
          animation: drpc-spin 0.8s linear infinite;
        }
        
        @keyframes drpc-spin {
          to { transform: rotate(360deg); }
        }
        
        .drpc-discord-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          justify-content: flex-start;
          padding-top: 2px;
        }
        
        .drpc-discord-details {
          font-size: 15px;
          font-weight: 600;
          color: #f2f3f5;
          margin-bottom: 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .drpc-discord-state {
          font-size: 13px;
          color: #b5bac1;
          margin-bottom: 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .drpc-discord-large-text {
          font-size: 13px;
          color: #b5bac1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-bottom: 6px;
        }
        
        .drpc-discord-progress {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        
        .drpc-discord-time {
          font-size: 11px;
          color: #b5bac1;
          font-variant-numeric: tabular-nums;
          min-width: 38px;
        }
        
        .drpc-discord-progress-bar {
          flex: 1;
          height: 4px;
          background: #3f4147;
          border-radius: 2px;
          overflow: hidden;
        }
        
        .drpc-discord-progress-fill {
          height: 100%;
          background: #ffffff;
          border-radius: 2px;
          width: 35%;
        }
        
        .drpc-discord-stopwatch {
          font-size: 12px;
          color: #23a55a;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .drpc-action-buttons {
          display: flex;
          gap: 12px;
          margin-top: 20px;
          padding-top: 20px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          pointer-events: auto !important;
        }
        .drpc-btn {
          flex: 1;
          padding: 10px 16px;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        .drpc-btn-primary {
          background: var(--accent-primary);
          color: white;
        }
        .drpc-btn-primary:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        }
        .drpc-btn-secondary {
          background: var(--bg-surface);
          color: var(--text-primary);
          border: 1px solid var(--border-color);
        }
        .drpc-btn-secondary:hover {
          background: var(--bg-highlight);
        }

        .drpc-warning-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          background: rgba(255, 193, 7, 0.1);
          border: 1px solid rgba(255, 193, 7, 0.3);
          border-radius: 6px;
          color: #ffc107;
          font-size: 12px;
          font-weight: 500;
          margin-top: 8px;
        }

        .drpc-info-box {
          padding: 12px;
          background: rgba(33, 150, 243, 0.1);
          border: 1px solid rgba(33, 150, 243, 0.15);
          border-radius: 8px;
          margin-top: 12px;
        }
        .drpc-input-group .drpc-info-box {
          margin-top: 4px;
        }
        .drpc-info-text {
          color: #2196F3;
          font-size: 12px;
          line-height: 1.5;
        }

        /* Confirmation modal */
        #drpc-confirm-overlay {
          display: none;
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.75);
          z-index: 10002;
          align-items: center;
          justify-content: center;
        }
        #drpc-confirm-overlay.open {
          display: flex;
        }
        #drpc-confirm-modal {
          background: var(--bg-elevated);
          border: 1px solid var(--border-color);
          border-radius: 12px;
          padding: 24px;
          max-width: 420px;
          width: 90%;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        }
        #drpc-confirm-modal .drpc-confirm-title {
          font-size: 15px;
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 12px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        #drpc-confirm-modal .drpc-confirm-title .drpc-confirm-icon {
          font-size: 18px;
        }
        #drpc-confirm-modal .drpc-confirm-body {
          font-size: 13px;
          color: var(--text-secondary);
          line-height: 1.6;
          margin-bottom: 8px;
        }
        #drpc-confirm-modal .drpc-confirm-body strong {
          color: var(--text-primary);
        }
        #drpc-confirm-modal .drpc-confirm-warning {
          font-size: 12px;
          color: #ffc107;
          background: rgba(255, 193, 7, 0.08);
          border: 1px solid rgba(255, 193, 7, 0.25);
          border-radius: 6px;
          padding: 10px 12px;
          margin: 12px 0;
          line-height: 1.5;
        }
        #drpc-confirm-modal .drpc-confirm-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          margin-top: 20px;
        }
      `;

      document.head.appendChild(style);
    },

    // Build and inject the settings modal DOM
    createSettingsModal() {
      if (document.getElementById("drpc-modal")) return;

      const overlay = document.createElement("div");
      overlay.id = "drpc-overlay";
      overlay.addEventListener("click", () => this.closeSettings());
      document.body.appendChild(overlay);

      const modal = document.createElement("div");
      modal.id = "drpc-modal";
      modal.innerHTML = `
        <div class="drpc-header">
          <h2>
            <span class="drpc-icon"><svg width="22" height="22" viewBox="0 -28.5 256 256" xmlns="http://www.w3.org/2000/svg"><path d="M216.856339,16.5966031 C200.285002,8.84328665 182.566144,3.2084988 164.041564,0 C161.766523,4.11318106 159.108624,9.64549908 157.276099,14.0464379 C137.583995,11.0849896 118.072967,11.0849896 98.7430163,14.0464379 C96.9108417,9.64549908 94.1925838,4.11318106 91.8971895,0 C73.3526068,3.2084988 55.6133949,8.86399117 39.0420583,16.6376612 C5.61752293,67.146514 -3.4433191,116.400813 1.08711069,164.955721 C23.2560196,181.510915 44.7403634,191.567697 65.8621325,198.148576 C71.0772151,190.971126 75.7283628,183.341335 79.7352139,175.300261 C72.104019,172.400575 64.7949724,168.822202 57.8887866,164.667963 C59.7209612,163.310589 61.5131304,161.891452 63.2445898,160.431257 C105.36741,180.133187 151.134928,180.133187 192.754523,160.431257 C194.506336,161.891452 196.298154,163.310589 198.110326,164.667963 C191.183787,168.842556 183.854737,172.420929 176.223542,175.320965 C180.230393,183.341335 184.861538,190.991831 190.096624,198.16893 C211.238746,191.588051 232.743023,181.531619 254.911949,164.955721 C260.227747,108.668201 245.831087,59.8662432 216.856339,16.5966031 Z M85.4738752,135.09489 C72.8290281,135.09489 62.4592217,123.290155 62.4592217,108.914901 C62.4592217,94.5396472 72.607595,82.7145587 85.4738752,82.7145587 C98.3405064,82.7145587 108.709962,94.5189427 108.488529,108.914901 C108.508531,123.290155 98.3405064,135.09489 85.4738752,135.09489 Z M170.525237,135.09489 C157.88039,135.09489 147.510584,123.290155 147.510584,108.914901 C147.510584,94.5396472 157.658606,82.7145587 170.525237,82.7145587 C183.391518,82.7145587 193.761324,94.5189427 193.539891,108.914901 C193.539891,123.290155 183.391518,135.09489 170.525237,135.09489 Z" fill="#5865F2" fill-rule="nonzero"></path></svg></span>
            Discord Rich Presence
          </h2>
          <button class="drpc-close-btn">×</button>
        </div>

        <div class="drpc-modal-body">

        <div class="drpc-settings-container ${this.settings.enabled ? "" : "disabled"}">
          <div class="drpc-section">
            <div class="drpc-status">
            <div class="drpc-status-dot"></div>
            <span class="drpc-status-text">Checking connection...</span>
          </div>

          <div class="drpc-toggle-section">
            <div class="drpc-toggle-label">
              <div class="drpc-toggle-title">Enable Rich Presence</div>
              <div class="drpc-toggle-desc">Show your music activity on Discord</div>
            </div>
            <label class="drpc-toggle">
              <input type="checkbox" id="drpc-enabled" ${this.settings.enabled ? "checked" : ""}>
              <span class="drpc-toggle-slider"></span>
            </label>
          </div>
          </div>

          <div class="drpc-section">
            <div class="drpc-section-title">Display Options</div>
            
            <div class="drpc-setting-item">
              <div class="drpc-setting-text">
                <div class="drpc-setting-label">Show Progress Bar</div>
                <div class="drpc-setting-desc">Display playback progress in Discord</div>
              </div>
              <label class="drpc-toggle">
                <input type="checkbox" id="drpc-show-progress" ${this.settings.showProgress ? "checked" : ""}>
                <span class="drpc-toggle-slider"></span>
              </label>
            </div>

            <div class="drpc-setting-item">
              <div class="drpc-setting-text">
                <div class="drpc-setting-label">Show Pause Icon</div>
                <div class="drpc-setting-desc">Display (Paused) on album art when paused</div>
              </div>
              <label class="drpc-toggle">
                <input type="checkbox" id="drpc-show-pause-icon" ${this.settings.showPauseIcon ? "checked" : ""}>
                <span class="drpc-toggle-slider"></span>
              </label>
            </div>
          </div>

          <div class="drpc-section">
            <div class="drpc-section-title">Cover Art</div>

            <div class="drpc-setting-item">
              <div class="drpc-setting-text">
                <div class="drpc-setting-label">Use Local Covers</div>
                <div class="drpc-setting-desc">
                  Uploads your local album art to <strong>catbox.moe</strong> (a public third-party host) so Discord can display it.
                  The image is stored publicly and permanently. Only enable this if you are comfortable with that.
                </div>
              </div>
              <label class="drpc-toggle">
                <input type="checkbox" id="drpc-use-local-covers" ${this.settings.useLocalCovers ? "checked" : ""}>
                <span class="drpc-toggle-slider"></span>
              </label>
            </div>

            <div class="drpc-setting-item">
              <div class="drpc-setting-text">
                <div class="drpc-setting-label">Use Online Covers</div>
                <div class="drpc-setting-desc">
                  Fetches album art from installed cover provider plugins (e.g. Tidal, Qobuz, Saavn).
                  Providers must be installed separately and registered as cover sources.
                  Use <em>Cover Priority</em> below to control which source wins.
                </div>
              </div>
              <label class="drpc-toggle">
                <input type="checkbox" id="drpc-use-online-covers" ${this.settings.useOnlineCovers ? "checked" : ""}>
                <span class="drpc-toggle-slider"></span>
              </label>
            </div>

            <div class="drpc-setting-item">
              <div style="width: 100%;">
                <div class="drpc-setting-label">Cover Priority</div>
                <div class="drpc-setting-desc">
                  Controls which cover source is preferred when multiple are available.
                  Enter source IDs separated by <code>/</code> in order of preference — e.g. <code>jiosaavn/qobuz/local/tidal</code>.
                  The plugin waits up to 4 seconds for the first result, then 2 more seconds for higher-priority sources before picking the best available.
                  Use <code>local</code> for local covers; other IDs must match the source ID registered by the provider plugin.
                </div>
                <div style="display: flex; gap: 8px; margin-top: 8px; align-items: center;">
                  <input
                    type="text"
                    id="drpc-cover-priority"
                    value="${this.settings.coverPriority}"
                    placeholder="jiosaavn/qobuz/local/tidal"
                    style="flex: 1; padding: 6px 8px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.2); color: inherit; font-size: 12px; box-sizing: border-box;"
                  >
                  <button class="drpc-btn drpc-btn-secondary" id="drpc-cover-priority-set" style="flex: none; padding: 6px 12px; font-size: 12px;">Set</button>
                </div>
                <div id="drpc-cover-priority-feedback" style="font-size: 11px; margin-top: 5px; min-height: 16px;"></div>
              </div>
            </div>

            <div class="drpc-setting-item">
              <div class="drpc-setting-text">
                <div class="drpc-setting-label">Refresh Cover Art</div>
                <div class="drpc-setting-desc">
                  Clears the cached cover for the current track and re-fetches it from scratch.
                  Use this if the wrong cover is showing on Discord.
                </div>
              </div>
              <button class="drpc-btn drpc-btn-secondary" id="drpc-refresh-cover-btn" style="flex: none; padding: 6px 12px; font-size: 12px;">Refresh</button>
            </div>
          </div>

          <div class="drpc-section">
            <div class="drpc-section-title">Activity Timeout</div>
            
            <div class="drpc-setting-item">
              <div class="drpc-setting-text">
                <div class="drpc-setting-label">Clear When Paused</div>
                <div class="drpc-setting-desc">Auto-clear presence after inactivity</div>
              </div>
              <label class="drpc-toggle">
                <input type="checkbox" id="drpc-timeout-enabled" ${this.settings.activityTimeoutEnabled ? "checked" : ""}>
                <span class="drpc-toggle-slider"></span>
              </label>
            </div>

            <div class="drpc-setting-item">
              <div style="width: 100%;">
                <div class="drpc-range-wrapper">
                  <div class="drpc-range-value">
                    <span>Timeout Duration</span>
                    <span id="drpc-timeout-display">${this.settings.activityTimeoutTime / 60000} min</span>
                  </div>
                  <input
                    type="range"
                    id="drpc-timeout-time"
                    class="drpc-range"
                    min="1"
                    max="30"
                    step="1"
                    value="${this.settings.activityTimeoutTime / 60000}"
                  >
                </div>
                <div class="drpc-info-box">
                  <div class="drpc-info-text">
                    Presence will clear automatically if music is paused for this long.
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="drpc-section">
            <div class="drpc-section-title">Update Frequency</div>
            <div class="drpc-setting-item">
              <div style="width: 100%;">
                <div class="drpc-range-wrapper">
                  <div class="drpc-range-value">
                    <span>Throttle Interval</span>
                    <span id="drpc-interval-display">${this.settings.updateInterval / 1000}s</span>
                  </div>
                  <input
                    type="range"
                    id="drpc-update-interval"
                    class="drpc-range"
                    min="10"
                    max="30"
                    step="1"
                    value="${this.settings.updateInterval / 1000}"
                  >
                </div>
                <div class="drpc-info-box">
                  <div class="drpc-info-text">
                    Normal playback updates throttled to this interval. Song changes, pauses, and seeks update immediately.
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="drpc-section">
            <div class="drpc-section-title">Display Format</div>
            
            <div class="drpc-input-group">
              <label>Status Display (Member List)</label>
              <select id="drpc-status-display-type" class="drpc-select">
                <option value="name">App Name</option>
                <option value="details">Details</option>
                <option value="state">State</option>
              </select>
              <div class="drpc-info-box">
                <div class="drpc-info-text">
                  Controls which field appears in your Discord status text (visible in member list).
                </div>
              </div>
            </div>

            <div class="drpc-input-group">
              <label>App Name</label>
              <div class="drpc-compound-format">
                <select id="drpc-app-name-left" class="drpc-select drpc-compound-select">
                  <option value="none">None</option>
                  <option value="track_title">Track Title</option>
                  <option value="artist">Artist</option>
                  <option value="album">Album</option>
                  <option value="custom">Custom</option>
                </select>
                <span class="drpc-compound-divider">•</span>
                <select id="drpc-app-name-right" class="drpc-select drpc-compound-select">
                  <option value="none">None</option>
                  <option value="track_title">Track Title</option>
                  <option value="artist">Artist</option>
                  <option value="album">Album</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <input
                type="text"
                id="drpc-app-name-custom-left"
                class="drpc-input"
                placeholder="Custom left text..."
                style="display: none;"
              >
              <input
                type="text"
                id="drpc-app-name-custom-right"
                class="drpc-input"
                placeholder="Custom right text..."
                style="display: none;"
              >
              <div class="drpc-info-box">
                <div class="drpc-info-text">
                  Overrides the default "Audion" app name. Leave both as "None" to use "Audion".
                </div>
              </div>
            </div>

            <div class="drpc-input-group">
              <label>Details</label>
              <div class="drpc-compound-format">
                <select id="drpc-line1-left" class="drpc-select drpc-compound-select">
                  <option value="none">None</option>
                  <option value="track_title">Track Title</option>
                  <option value="artist">Artist</option>
                  <option value="album">Album</option>
                  <option value="custom">Custom</option>
                </select>
                <span class="drpc-compound-divider">•</span>
                <select id="drpc-line1-right" class="drpc-select drpc-compound-select">
                  <option value="none">None</option>
                  <option value="track_title">Track Title</option>
                  <option value="artist">Artist</option>
                  <option value="album">Album</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <input
                type="text"
                id="drpc-line1-custom-left"
                class="drpc-input"
                placeholder="Custom left text..."
                style="display: none;"
              >
              <input
                type="text"
                id="drpc-line1-custom-right"
                class="drpc-input"
                placeholder="Custom right text..."
                style="display: none;"
              >
            </div>

            <div class="drpc-input-group">
              <label>State</label>
              <div class="drpc-compound-format">
                <select id="drpc-line2-left" class="drpc-select drpc-compound-select">
                  <option value="none">None</option>
                  <option value="track_title">Track Title</option>
                  <option value="artist">Artist</option>
                  <option value="album">Album</option>
                  <option value="custom">Custom</option>
                </select>
                <span class="drpc-compound-divider">•</span>
                <select id="drpc-line2-right" class="drpc-select drpc-compound-select">
                  <option value="none">None</option>
                  <option value="track_title">Track Title</option>
                  <option value="artist">Artist</option>
                  <option value="album">Album</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <input
                type="text"
                id="drpc-line2-custom-left"
                class="drpc-input"
                placeholder="Custom left text..."
                style="display: none;"
              >
              <input
                type="text"
                id="drpc-line2-custom-right"
                class="drpc-input"
                placeholder="Custom right text..."
                style="display: none;"
              >
            </div>

            <div class="drpc-input-group">
              <label>Album Details</label>
              <div class="drpc-compound-format">
                <select id="drpc-line3-left" class="drpc-select drpc-compound-select">
                  <option value="none">None</option>
                  <option value="track_title">Track Title</option>
                  <option value="artist">Artist</option>
                  <option value="album">Album</option>
                  <option value="custom">Custom</option>
                </select>
                <span class="drpc-compound-divider">•</span>
                <select id="drpc-line3-right" class="drpc-select drpc-compound-select">
                  <option value="none">None</option>
                  <option value="track_title">Track Title</option>
                  <option value="artist">Artist</option>
                  <option value="album">Album</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <input
                type="text"
                id="drpc-line3-custom-left"
                class="drpc-input"
                placeholder="Custom left text..."
                style="display: none;"
              >
              <input
                type="text"
                id="drpc-line3-custom-right"
                class="drpc-input"
                placeholder="Custom right text..."
                style="display: none;"
              >
            </div>

            <div class="drpc-preview">
              <div class="drpc-preview-title">PREVIEW</div>
              <div class="drpc-preview-content"></div>
            </div>
          </div>
        </div>

        <div class="drpc-action-buttons">
          <button class="drpc-btn drpc-btn-secondary" id="drpc-reset-btn">Reset Defaults</button>
          <button class="drpc-btn drpc-btn-primary" id="drpc-save-btn">Save Settings</button>
        </div>
      </div>  
      `;

      document.body.appendChild(modal);

      // Confirmation modal for local cover upload
      const confirmOverlay = document.createElement("div");
      confirmOverlay.id = "drpc-confirm-overlay";
      confirmOverlay.innerHTML = `
        <div id="drpc-confirm-modal">
          <div class="drpc-confirm-title">
            <span class="drpc-confirm-icon">⚠️</span>
            Third-Party Upload Warning
          </div>
          <div class="drpc-confirm-body">
            Enabling <strong>Use Local Covers</strong> will upload your local album art to
            <strong>catbox.moe</strong>, a public third-party file hosting service.
          </div>
          <div class="drpc-confirm-warning">
            Uploaded images are stored <strong>publicly and permanently</strong> on catbox.moe's servers.
            Anyone with the link can view them. Audion has no control over catbox.moe's availability,
            policies, or data handling. Proceed only if you are comfortable with this.
          </div>
          <div class="drpc-confirm-body">
            You can disable this at any time to stop future uploads. Images already uploaded will remain on catbox.moe.
          </div>
          <div class="drpc-confirm-actions">
            <button class="drpc-btn drpc-btn-secondary" id="drpc-confirm-cancel">Cancel</button>
            <button class="drpc-btn drpc-btn-primary" id="drpc-confirm-accept">I Understand, Enable</button>
          </div>
        </div>
      `;
      document.body.appendChild(confirmOverlay);

      confirmOverlay.querySelector("#drpc-confirm-cancel").addEventListener("click", () => {
        confirmOverlay.classList.remove("open");
        // Revert the toggle visually
        modal.querySelector("#drpc-use-local-covers").checked = false;
        this.tempSettings.useLocalCovers = false;
      });

      confirmOverlay.querySelector("#drpc-confirm-accept").addEventListener("click", () => {
        confirmOverlay.classList.remove("open");
        modal.querySelector("#drpc-use-local-covers").checked = true;
        this.tempSettings.useLocalCovers = true;
      });

      modal
        .querySelector(".drpc-close-btn")
        .addEventListener("click", () => this.closeSettings());

      const enabledToggle = modal.querySelector("#drpc-enabled");
      enabledToggle.addEventListener("change", (e) => {
        this.tempSettings.enabled = e.target.checked;
        const container = modal.querySelector(".drpc-settings-container");
        container.classList.toggle("disabled", !e.target.checked);
        this.updateConnectionStatus();
      });

      modal
        .querySelector("#drpc-show-progress")
        .addEventListener("change", (e) => {
          this.tempSettings.showProgress = e.target.checked;
          this.updatePreview();
        });

      modal
        .querySelector("#drpc-show-pause-icon")
        .addEventListener("change", (e) => {
          this.tempSettings.showPauseIcon = e.target.checked;
        });

      modal
        .querySelector("#drpc-refresh-cover-btn")
        .addEventListener("click", () => this.refreshCover());

      modal
        .querySelector("#drpc-use-local-covers")
        .addEventListener("change", (e) => {
          if (e.target.checked) {
            // show confirmation before enabling . will set tempSettings on accept
            e.target.checked = false; // revert until confirmed
            document.getElementById("drpc-confirm-overlay").classList.add("open");
          } else {
            this.tempSettings.useLocalCovers = false;
          }
        });

      modal
        .querySelector("#drpc-use-online-covers")
        .addEventListener("change", (e) => {
          this.tempSettings.useOnlineCovers = e.target.checked;
        });

      modal
        .querySelector("#drpc-cover-priority-set")
        .addEventListener("click", () => {
          const input = modal.querySelector("#drpc-cover-priority");
          const feedback = modal.querySelector("#drpc-cover-priority-feedback");
          const value = input.value.trim();

          // validate: only letters and slashes, no leading/trailing slash, no double slash
          const valid =
            value.length > 0 &&
            /^[a-zA-Z]+(?:\/[a-zA-Z]+)*$/.test(value);

          if (valid) {
            this.tempSettings.coverPriority = value.toLowerCase();
            input.style.borderColor = "rgba(59, 165, 93, 0.6)";
            feedback.style.color = "#3ba55d";
            feedback.textContent = "✓ Priority saved.";
            setTimeout(() => {
              input.style.borderColor = "rgba(255,255,255,0.15)";
              feedback.textContent = "";
            }, 2000);
          } else {
            input.style.borderColor = "rgba(237, 66, 69, 0.7)";
            feedback.style.color = "#ed4245";
            feedback.textContent = "Invalid format. Use letters and slashes only, e.g. jiosaavn/qobuz/local/tidal";
            setTimeout(() => {
              input.style.borderColor = "rgba(255,255,255,0.15)";
            }, 2500);
          }
        });

      modal
        .querySelector("#drpc-timeout-enabled")
        .addEventListener("change", (e) => {
          this.tempSettings.activityTimeoutEnabled = e.target.checked;
        });

      const timeoutSlider = modal.querySelector("#drpc-timeout-time");
      const timeoutDisplay = modal.querySelector("#drpc-timeout-display");
      timeoutSlider.addEventListener("input", (e) => {
        const minutes = parseInt(e.target.value);
        timeoutDisplay.textContent = `${minutes} min`;
        this.tempSettings.activityTimeoutTime = minutes * 60000;
      });

      const intervalSlider = modal.querySelector("#drpc-update-interval");
      const intervalDisplay = modal.querySelector("#drpc-interval-display");
      intervalSlider.addEventListener("input", (e) => {
        const seconds = parseInt(e.target.value);
        intervalDisplay.textContent = `${seconds}s`;
        this.tempSettings.updateInterval = seconds * 1000;
      });

      const statusDisplayType = modal.querySelector(
        "#drpc-status-display-type",
      );
      statusDisplayType.value = this.settings.statusDisplayType;
      statusDisplayType.addEventListener("change", (e) => {
        this.tempSettings.statusDisplayType = e.target.value;
        this.updatePreview();
      });

      const appNameLeft = modal.querySelector("#drpc-app-name-left");
      const appNameRight = modal.querySelector("#drpc-app-name-right");
      const appNameCustomLeft = modal.querySelector(
        "#drpc-app-name-custom-left",
      );
      const appNameCustomRight = modal.querySelector(
        "#drpc-app-name-custom-right",
      );

      appNameLeft.value = this.settings.appNameLeft;
      appNameRight.value = this.settings.appNameRight;
      appNameCustomLeft.value = this.settings.appNameCustomLeft;
      appNameCustomRight.value = this.settings.appNameCustomRight;

      const line1Left = modal.querySelector("#drpc-line1-left");
      const line1Right = modal.querySelector("#drpc-line1-right");
      const line1CustomLeft = modal.querySelector("#drpc-line1-custom-left");
      const line1CustomRight = modal.querySelector("#drpc-line1-custom-right");

      line1Left.value = this.settings.line1Left;
      line1Right.value = this.settings.line1Right;
      line1CustomLeft.value = this.settings.line1CustomLeft;
      line1CustomRight.value = this.settings.line1CustomRight;

      const line2Left = modal.querySelector("#drpc-line2-left");
      const line2Right = modal.querySelector("#drpc-line2-right");
      const line2CustomLeft = modal.querySelector("#drpc-line2-custom-left");
      const line2CustomRight = modal.querySelector("#drpc-line2-custom-right");

      line2Left.value = this.settings.line2Left;
      line2Right.value = this.settings.line2Right;
      line2CustomLeft.value = this.settings.line2CustomLeft;
      line2CustomRight.value = this.settings.line2CustomRight;

      const line3Left = modal.querySelector("#drpc-line3-left");
      const line3Right = modal.querySelector("#drpc-line3-right");
      const line3CustomLeft = modal.querySelector("#drpc-line3-custom-left");
      const line3CustomRight = modal.querySelector("#drpc-line3-custom-right");

      line3Left.value = this.settings.line3Left;
      line3Right.value = this.settings.line3Right;
      line3CustomLeft.value = this.settings.line3CustomLeft;
      line3CustomRight.value = this.settings.line3CustomRight;

      const updateCustomInputs = () => {
        appNameCustomLeft.style.display =
          appNameLeft.value === "custom" ? "block" : "none";
        appNameCustomRight.style.display =
          appNameRight.value === "custom" ? "block" : "none";
        line1CustomLeft.style.display =
          line1Left.value === "custom" ? "block" : "none";
        line1CustomRight.style.display =
          line1Right.value === "custom" ? "block" : "none";
        line2CustomLeft.style.display =
          line2Left.value === "custom" ? "block" : "none";
        line2CustomRight.style.display =
          line2Right.value === "custom" ? "block" : "none";
        line3CustomLeft.style.display =
          line3Left.value === "custom" ? "block" : "none";
        line3CustomRight.style.display =
          line3Right.value === "custom" ? "block" : "none";
      };

      updateCustomInputs();

      appNameLeft.addEventListener("change", (e) => {
        this.tempSettings.appNameLeft = e.target.value;
        updateCustomInputs();
        this.updatePreview();
      });
      appNameRight.addEventListener("change", (e) => {
        this.tempSettings.appNameRight = e.target.value;
        updateCustomInputs();
        this.updatePreview();
      });
      appNameCustomLeft.addEventListener("input", (e) => {
        this.tempSettings.appNameCustomLeft = e.target.value;
        this.updatePreview();
      });
      appNameCustomRight.addEventListener("input", (e) => {
        this.tempSettings.appNameCustomRight = e.target.value;
        this.updatePreview();
      });

      line1Left.addEventListener("change", (e) => {
        this.tempSettings.line1Left = e.target.value;
        updateCustomInputs();
        this.updatePreview();
      });
      line1Right.addEventListener("change", (e) => {
        this.tempSettings.line1Right = e.target.value;
        updateCustomInputs();
        this.updatePreview();
      });
      line1CustomLeft.addEventListener("input", (e) => {
        this.tempSettings.line1CustomLeft = e.target.value;
        this.updatePreview();
      });
      line1CustomRight.addEventListener("input", (e) => {
        this.tempSettings.line1CustomRight = e.target.value;
        this.updatePreview();
      });

      line2Left.addEventListener("change", (e) => {
        this.tempSettings.line2Left = e.target.value;
        updateCustomInputs();
        this.updatePreview();
      });
      line2Right.addEventListener("change", (e) => {
        this.tempSettings.line2Right = e.target.value;
        updateCustomInputs();
        this.updatePreview();
      });
      line2CustomLeft.addEventListener("input", (e) => {
        this.tempSettings.line2CustomLeft = e.target.value;
        this.updatePreview();
      });
      line2CustomRight.addEventListener("input", (e) => {
        this.tempSettings.line2CustomRight = e.target.value;
        this.updatePreview();
      });

      line3Left.addEventListener("change", (e) => {
        this.tempSettings.line3Left = e.target.value;
        updateCustomInputs();
        this.updatePreview();
      });
      line3Right.addEventListener("change", (e) => {
        this.tempSettings.line3Right = e.target.value;
        updateCustomInputs();
        this.updatePreview();
      });
      line3CustomLeft.addEventListener("input", (e) => {
        this.tempSettings.line3CustomLeft = e.target.value;
        this.updatePreview();
      });
      line3CustomRight.addEventListener("input", (e) => {
        this.tempSettings.line3CustomRight = e.target.value;
        this.updatePreview();
      });

      modal
        .querySelector("#drpc-reset-btn")
        .addEventListener("click", () => this.resetSettings());
      modal.querySelector("#drpc-save-btn").addEventListener("click", () => {
        this.applySettings();
        this.closeSettings();
      });

      this.updatePreview();
    },

    // Register menu button in Audion playerbar
    createMenuButton() {
      if (!this.api?.ui) return;

      const button = document.createElement("button");
      button.style.cssText = `display: flex; align-items: center; gap: 8px;`;
      button.innerHTML = `
        <svg width="18" height="18" viewBox="0 -28.5 256 256" xmlns="http://www.w3.org/2000/svg" style="margin-top: -0.5px">
          <path d="M216.856339,16.5966031 C200.285002,8.84328665 182.566144,3.2084988 164.041564,0 C161.766523,4.11318106 159.108624,9.64549908 157.276099,14.0464379 C137.583995,11.0849896 118.072967,11.0849896 98.7430163,14.0464379 C96.9108417,9.64549908 94.1925838,4.11318106 91.8971895,0 C73.3526068,3.2084988 55.6133949,8.86399117 39.0420583,16.6376612 C5.61752293,67.146514 -3.4433191,116.400813 1.08711069,164.955721 C23.2560196,181.510915 44.7403634,191.567697 65.8621325,198.148576 C71.0772151,190.971126 75.7283628,183.341335 79.7352139,175.300261 C72.104019,172.400575 64.7949724,168.822202 57.8887866,164.667963 C59.7209612,163.310589 61.5131304,161.891452 63.2445898,160.431257 C105.36741,180.133187 151.134928,180.133187 192.754523,160.431257 C194.506336,161.891452 196.298154,163.310589 198.110326,164.667963 C191.183787,168.842556 183.854737,172.420929 176.223542,175.320965 C180.230393,183.341335 184.861538,190.991831 190.096624,198.16893 C211.238746,191.588051 232.743023,181.531619 254.911949,164.955721 C260.227747,108.668201 245.831087,59.8662432 216.856339,16.5966031 Z M85.4738752,135.09489 C72.8290281,135.09489 62.4592217,123.290155 62.4592217,108.914901 C62.4592217,94.5396472 72.607595,82.7145587 85.4738752,82.7145587 C98.3405064,82.7145587 108.709962,94.5189427 108.488529,108.914901 C108.508531,123.290155 98.3405064,135.09489 85.4738752,135.09489 Z M170.525237,135.09489 C157.88039,135.09489 147.510584,123.290155 147.510584,108.914901 C147.510584,94.5396472 157.658606,82.7145587 170.525237,82.7145587 C183.391518,82.7145587 193.761324,94.5189427 193.539891,108.914901 C193.539891,123.290155 183.391518,135.09489 170.525237,135.09489 Z" fill="#5865F2" fill-rule="nonzero"></path>
        </svg>
        <span>Discord Rich Presence</span>
      `;

      button.addEventListener("click", () => this.openSettings());

      this.api.ui.registerSlot("playerbar:menu", button, 5);
    },

    // Open the settings modal
    openSettings() {
      this.isSettingsOpen = true;
      this.tempSettings = { ...this.settings };

      const modal = document.getElementById("drpc-modal");
      const overlay = document.getElementById("drpc-overlay");

      modal.classList.add("open");
      overlay.classList.add("open");

      this.updateConnectionStatus();
      this.updatePreview();
      this.startConnectionStatusPolling();
    },

    // Close the settings modal and clean up
    closeSettings() {
      this.isSettingsOpen = false;
      const modal = document.getElementById("drpc-modal");
      const overlay = document.getElementById("drpc-overlay");
      const confirmOverlay = document.getElementById("drpc-confirm-overlay");

      modal.classList.remove("open");
      overlay.classList.remove("open");
      if (confirmOverlay) confirmOverlay.classList.remove("open");

      this.stopConnectionStatusPolling();
    },

    // Poll Discord connection status while modal is open
    startConnectionStatusPolling() {
      this.stopConnectionStatusPolling();
      this.updateConnectionStatus();

      this.connectionStatusInterval = setInterval(() => {
        if (this.isSettingsOpen) {
          this.updateConnectionStatus();
        }
      }, 500);
    },

    // Stop polling connection status
    stopConnectionStatusPolling() {
      if (this.connectionStatusInterval) {
        clearInterval(this.connectionStatusInterval);
        this.connectionStatusInterval = null;
      }
    },

    // Update status indicator dot and text in modal
    updateConnectionStatus() {
      const statusDot = document.querySelector(".drpc-status-dot");
      const statusText = document.querySelector(".drpc-status-text");

      if (!statusDot || !statusText) return;

      const settings = this.tempSettings || this.settings;

      if (!settings.enabled) {
        statusDot.className = "drpc-status-dot disabled";
        statusText.textContent = "Rich Presence Disabled";
        return;
      }

      if (this.isConnected) {
        statusDot.className = "drpc-status-dot connected";
        statusText.textContent = "Connected to Discord";
      } else {
        statusDot.className = "drpc-status-dot disconnected";
        statusText.textContent = "Disconnected from Discord";
      }
    },

    // Re-render the Discord presence preview card
    async updatePreview() {
      if (!this.isSettingsOpen) return;

      const previewContent = document.querySelector(".drpc-preview-content");
      if (!previewContent) return;

      const settings = this.tempSettings || this.settings;

      let track = null;
      try {
        track = this.api?.player?.getCurrentTrack?.() || this.currentTrack;
      } catch (e) {
      }

      const mockTrack = {
        title: "Song Title",
        artist: "Artist Name",
        album: "Album Name",
      };

      const buildFormatWithFallback = (
        leftType,
        rightType,
        leftCustom,
        rightCustom,
      ) => {
        const parts = [];

        if (leftType === "custom" && leftCustom) {
          parts.push(leftCustom);
        } else if (leftType === "track_title") {
          parts.push(track?.title || mockTrack.title);
        } else if (leftType === "artist") {
          parts.push(track?.artist || mockTrack.artist);
        } else if (leftType === "album") {
          parts.push(track?.album || mockTrack.album);
        }

        if (rightType === "custom" && rightCustom) {
          parts.push(rightCustom);
        } else if (rightType === "track_title") {
          parts.push(track?.title || mockTrack.title);
        } else if (rightType === "artist") {
          parts.push(track?.artist || mockTrack.artist);
        } else if (rightType === "album") {
          parts.push(track?.album || mockTrack.album);
        }

        return parts.filter(Boolean).join(" • ");
      };

      const appNameText = buildFormatWithFallback(
        settings.appNameLeft,
        settings.appNameRight,
        settings.appNameCustomLeft,
        settings.appNameCustomRight,
      );

      const line1Text = buildFormatWithFallback(
        settings.line1Left,
        settings.line1Right,
        settings.line1CustomLeft,
        settings.line1CustomRight,
      );

      const line2Text = buildFormatWithFallback(
        settings.line2Left,
        settings.line2Right,
        settings.line2CustomLeft,
        settings.line2CustomRight,
      );

      const line3Text = buildFormatWithFallback(
        settings.line3Left,
        settings.line3Right,
        settings.line3CustomLeft,
        settings.line3CustomRight,
      );

      const listeningToText = appNameText || "Audion";

      let coverHtml = '<div class="drpc-discord-image">🎵</div>';
      const rawCover = track?.cover_url || track?.track_cover_path || track?.track_cover;
      if (rawCover) {
        let src = rawCover;
        if (!src.startsWith("http") && !src.startsWith("data:")) {
          src = "http://asset.localhost/" + encodeURIComponent(src.replace(/^file:\/{2,3}/, ""));
        }
        coverHtml = `<div class="drpc-discord-image"><img src="${src}" alt="Album Cover"></div>`;
      }

      previewContent.innerHTML = `
          <div class="drpc-discord-card">
          <div class="drpc-discord-app">Listening to ${listeningToText}</div>
          <div class="drpc-discord-menu">⋯</div>
          
          <div class="drpc-discord-main">
            ${coverHtml}
            <div class="drpc-discord-info">
              <div class="drpc-discord-details">
                ${line1Text || '<span style="opacity: 0.5">(empty)</span>'}
              </div>
              <div class="drpc-discord-state">
                ${line2Text || '<span style="opacity: 0.5">(empty)</span>'}
              </div>
              <div class="drpc-discord-large-text">
                ${line3Text || '<span style="opacity: 0.5">(empty)</span>'}
              </div>
              
              ${
                settings.showProgress
                  ? `<div class="drpc-discord-progress">
                    <span class="drpc-discord-time">1:23</span>
                    <div class="drpc-discord-progress-bar">
                      <div class="drpc-discord-progress-fill"></div>
                    </div>
                    <span class="drpc-discord-time">3:45</span>
                  </div>`
                  : `<div class="drpc-discord-stopwatch">
                    <span>♫</span>
                    <span>1:23</span>
                  </div>`
              }
            </div>
          </div>
        </div>
      `;
    },

    // Reset all settings to defaults
    resetSettings() {
      this.tempSettings = { ...this.defaultSettings };

      const modal = document.getElementById("drpc-modal");
      modal.querySelector("#drpc-enabled").checked = this.tempSettings.enabled;
      modal.querySelector("#drpc-show-progress").checked =
        this.tempSettings.showProgress;
      modal.querySelector("#drpc-show-pause-icon").checked =
        this.tempSettings.showPauseIcon;
      modal.querySelector("#drpc-use-local-covers").checked =
        this.tempSettings.useLocalCovers;
      modal.querySelector("#drpc-use-online-covers").checked =
        this.tempSettings.useOnlineCovers;
      modal.querySelector("#drpc-cover-priority").value =
        this.tempSettings.coverPriority;
      modal.querySelector("#drpc-cover-priority").style.borderColor = "rgba(255,255,255,0.15)";
      modal.querySelector("#drpc-cover-priority-feedback").textContent = "";
      modal.querySelector("#drpc-timeout-enabled").checked =
        this.tempSettings.activityTimeoutEnabled;

      modal.querySelector("#drpc-timeout-time").value =
        this.tempSettings.activityTimeoutTime / 60000;
      modal.querySelector("#drpc-timeout-display").textContent =
        `${this.tempSettings.activityTimeoutTime / 60000} min`;

      modal.querySelector("#drpc-update-interval").value =
        this.tempSettings.updateInterval / 1000;
      modal.querySelector("#drpc-interval-display").textContent =
        `${this.tempSettings.updateInterval / 1000}s`;

      modal.querySelector("#drpc-status-display-type").value =
        this.tempSettings.statusDisplayType;

      modal.querySelector("#drpc-app-name-left").value =
        this.tempSettings.appNameLeft;
      modal.querySelector("#drpc-app-name-right").value =
        this.tempSettings.appNameRight;
      modal.querySelector("#drpc-line1-left").value =
        this.tempSettings.line1Left;
      modal.querySelector("#drpc-line1-right").value =
        this.tempSettings.line1Right;
      modal.querySelector("#drpc-line2-left").value =
        this.tempSettings.line2Left;
      modal.querySelector("#drpc-line2-right").value =
        this.tempSettings.line2Right;
      modal.querySelector("#drpc-line3-left").value =
        this.tempSettings.line3Left;
      modal.querySelector("#drpc-line3-right").value =
        this.tempSettings.line3Right;

      modal.querySelector("#drpc-app-name-custom-left").value = "";
      modal.querySelector("#drpc-app-name-custom-right").value = "";
      modal.querySelector("#drpc-line1-custom-left").value = "";
      modal.querySelector("#drpc-line1-custom-right").value = "";
      modal.querySelector("#drpc-line2-custom-left").value = "";
      modal.querySelector("#drpc-line2-custom-right").value = "";
      modal.querySelector("#drpc-line3-custom-left").value = "";
      modal.querySelector("#drpc-line3-custom-right").value = "";

      modal
        .querySelector(".drpc-settings-container")
        .classList.remove("disabled");

      this.updateConnectionStatus();
      this.updatePreview();
    },

    // Build a formatted string from left/right field config
    buildCompoundFormat(leftType, rightType, leftCustom, rightCustom, track) {
      const parts = [];

      if (leftType === "custom" && leftCustom) {
        parts.push(leftCustom);
      } else if (leftType === "track_title" && track?.title) {
        parts.push(track.title);
      } else if (leftType === "artist" && track?.artist) {
        parts.push(track.artist);
      } else if (leftType === "album" && track?.album) {
        parts.push(track.album);
      }

      if (rightType === "custom" && rightCustom) {
        parts.push(rightCustom);
      } else if (rightType === "track_title" && track?.title) {
        parts.push(track.title);
      } else if (rightType === "artist" && track?.artist) {
        parts.push(track.artist);
      } else if (rightType === "album" && track?.album) {
        parts.push(track.album);
      }

      return parts.filter(Boolean).join(" • ");
    },

    // Connect to Discord RPC with exponential backoff
    async connect() {
      if (this.isConnected) return;

      try {
        await this.api.discord.connect();
        this.isConnected = true;
        this.reconnectAttempts = 0;

        if (this.currentTrack) {
          this.updatePresence(true);
        }
      } catch (error) {
        console.error("[Discord RPC] Connection failed:", error);
        this.isConnected = false;

        this.reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);

        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = setTimeout(() => {
          if (this.settings.enabled) {
            this.connect();
          }
        }, delay);
      }
    },

    // Disconnect from Discord RPC
    async disconnect() {
      if (!this.isConnected) return;

      try {
        await this.api.discord.disconnect();
        this.isConnected = false;
        this.reconnectAttempts = 0;
      } catch (error) {
        console.error("[Discord RPC] Disconnect error:", error);
      }
    },

    // Handle track change: update state and push presence
    handleTrackChange(data) {
      const { track } = data;
      if (!track) return;

      if (this.currentTrack && this.currentTrack.id === track.id) {
        return;
      }

      this.currentTrack = track;
      this.duration = track.duration || 0;

      try {
        this.currentTime = this.api.player.getCurrentTime();
        this.isPlaying = this.api.player.isPlaying();
      } catch (error) {
        this.currentTime = 0;
      }

      if (this.activityClearTimeout) {
        clearTimeout(this.activityClearTimeout);
        this.activityClearTimeout = null;
      }

      this.updatePresence(true);

      if (this.isSettingsOpen) {
        this.updatePreview();
      }
    },

    // Handle play/pause state change
    handlePlaybackState(data) {
      const { isPlaying } = data;

      if (this.isPlaying === isPlaying) {
        return;
      }

      this.isPlaying = isPlaying;

      if (this.activityClearTimeout) {
        clearTimeout(this.activityClearTimeout);
        this.activityClearTimeout = null;
      }

      this.updatePresence(true);

      if (!isPlaying && this.settings.activityTimeoutEnabled) {
        this.setActivityTimeout();
      }
    },

    // Handle time update: schedule throttled presence update
    handleTimeUpdate(data) {
      const { currentTime, duration } = data;
      this.currentTime = currentTime || 0;
      this.duration = duration || this.duration;

      this.scheduleUpdate();
    },

    // Handle seek: push immediate presence update
    handleSeeked(data) {
      const { currentTime, duration } = data;
      this.currentTime = currentTime || 0;
      this.duration = duration || this.duration;

      this.updatePresence(true);
    },

    // Schedule throttled presence update
    scheduleUpdate() {
      const now = Date.now();

      const songChanged = this.currentTrack?.id !== this.lastTrackId;
      const pauseChanged = this.isPlaying !== this.lastPlayingState;
      const timeDiff = Math.abs(this.currentTime - this.lastTime);
      const seeked = timeDiff > 2;

      if (songChanged || pauseChanged || seeked) {
        if (this.updateTimeout) {
          clearTimeout(this.updateTimeout);
          this.updateTimeout = null;
        }
        this.updatePresence(true);
        this.lastTime = this.currentTime;
        return;
      }

      this.lastTime = this.currentTime;

      const timeSinceLastUpdate = now - this.lastProgressUpdate;

      if (timeSinceLastUpdate >= this.settings.updateInterval) {
        if (this.updateTimeout) {
          clearTimeout(this.updateTimeout);
          this.updateTimeout = null;
        }
        this.updatePresence();
      } else if (!this.updateTimeout) {
        const delay = this.settings.updateInterval - timeSinceLastUpdate;
        this.updateTimeout = setTimeout(() => {
          this.updatePresence();
          this.updateTimeout = null;
        }, delay);
      }
    },

    // Set timeout to clear presence when paused too long
    setActivityTimeout() {
      if (this.activityClearTimeout) {
        clearTimeout(this.activityClearTimeout);
        this.activityClearTimeout = null;
      }

      if (
        !this.isPlaying &&
        this.settings.activityTimeoutEnabled &&
        this.settings.activityTimeoutTime > 0
      ) {
        this.activityClearTimeout = setTimeout(() => {
          this.clearPresence();
        }, this.settings.activityTimeoutTime);
      }
    },

    // Send presence data to Discord with concurrency guard
    async updatePresence(forceUpdate = false) {
      if (!this.settings.enabled || !this.isConnected) return;
      if (this._updatePresenceLock) return;
      this._updatePresenceLock = true;

      const capturedIsPlaying = this.isPlaying;

      try {
        if (!forceUpdate) {
          const now = Date.now();
          const timeSinceLastUpdate = now - this.lastProgressUpdate;

          if (timeSinceLastUpdate < this.settings.updateInterval) {
            return;
          }
        }

        if (!this.currentTrack) return;

        try {
          this.currentTime = this.api.player.getCurrentTime();
          this.duration = this.api.player.getDuration();
        } catch (error) {}

        if (!forceUpdate && capturedIsPlaying && this.currentTime === 0) {
          return;
        }

        this.lastTrackId = this.currentTrack?.id;
        this.lastPlayingState = this.isPlaying;

        const line1 = this.buildCompoundFormat(
          this.settings.line1Left,
          this.settings.line1Right,
          this.settings.line1CustomLeft,
          this.settings.line1CustomRight,
          this.currentTrack,
        );

        const line2 = this.buildCompoundFormat(
          this.settings.line2Left,
          this.settings.line2Right,
          this.settings.line2CustomLeft,
          this.settings.line2CustomRight,
          this.currentTrack,
        );

        const line3 = this.buildCompoundFormat(
          this.settings.line3Left,
          this.settings.line3Right,
          this.settings.line3CustomLeft,
          this.settings.line3CustomRight,
          this.currentTrack,
        );

        const appName = this.buildCompoundFormat(
          this.settings.appNameLeft,
          this.settings.appNameRight,
          this.settings.appNameCustomLeft,
          this.settings.appNameCustomRight,
          this.currentTrack,
        );

        const buildPresenceData = (coverUrl) => ({
          line1: line1 || "Unknown",
          line2: line2 || "Unknown",
          line3: line3 || null,
          app_name: appName || null,
          status_display_type: this.settings.statusDisplayType,
          cover_url: coverUrl || null,
          track_id: this.currentTrack?.id ?? null,
          track_cover_path: this.settings.useLocalCovers
            ? (this.currentTrack?.track_cover_path || null)
            : null,
          current_time: Math.floor(this.currentTime * 1000),
          duration: Math.floor(this.duration * 1000),
          is_playing: capturedIsPlaying,
          show_pause_icon: this.settings.showPauseIcon,
        });

        try {
          // send immediately with no cover => don't block on cover resolution
          await this.api.discord.updatePresence(buildPresenceData(null));
          this.lastProgressUpdate = Date.now();

          // resolve cover in background; update presence again when ready
          const trackSnapshot = this.currentTrack;
          this.resolveCover(trackSnapshot).then(async (coverUrl) => {
            // only apply if we're still on the same track
            if (!coverUrl || this.currentTrack?.id !== trackSnapshot?.id) return;
            try {
              await this.api.discord.updatePresence(buildPresenceData(coverUrl));
            } catch (e) {
              console.error("[Discord RPC] Cover presence update failed:", e);
            }
          });
        } catch (error) {
          console.error("[Discord RPC] Update failed:", error);
          this.isConnected = false;
          const isSocketError = error && error.message && error.message.includes("IPC socket");
          const delay = isSocketError ? 30000 : 2000;
          if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = setTimeout(() => this.connect(), delay);
        }
      } finally {
        this._updatePresenceLock = false;
      }
    },

    // resolve the best available cover URL for a track
    // fires local backend call and/or online provider query in parallel,
    // waits up to 4s for the first result, then 2s more for higher-priority sources
    // returns the highest-priority cover URL available, or null if none found
    async resolveCover(track) {
      if (!track?.id) return null;

      const trackId = track.id;

      // cache hit => return immediately
      if (this.coverCache.has(trackId)) {
        return this.coverCache.get(trackId);
      }

      const priority = (this.settings.coverPriority || "local")
        .toLowerCase()
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);

      const useLocal = this.settings.useLocalCovers && priority.includes("local");
      const useOnline = this.settings.useOnlineCovers && priority.some((p) => p !== "local");

      if (!useLocal && !useOnline) return null;

      // collect results as they arrive: sourceId -> url
      const results = new Map();
      const promises = [];

      const pickBest = () => {
        for (const source of priority) {
          if (results.has(source)) return results.get(source);
        }
        return null;
      };

      // local: ask backend to resolve (upload if needed) and return the URL
      // only passes track_cover_path when useLocalCovers is on . backend only uploads then
      if (useLocal) {
        if (track.cover_url?.startsWith("https://")) {
          // already persisted from a previous play , use directly, no upload needed
          results.set("local", track.cover_url);
        } else if (track.track_cover_path) {
          const localPromise = this.api.discord.resolveCover(
            track.id,
            track.track_cover_path
          ).then((url) => {
            if (url) results.set("local", url);
          }).catch(() => {});
          promises.push(localPromise);
        }
      }

      // online: fan out to registered runtime providers
      if (useOnline) {
        const onlinePromise = new Promise((resolve) => {
          this.api.covers.query(
            { title: track.title || "", artist: track.artist || "", album: track.album || "" },
            (result) => {
              if (result.status === "success" && result.url?.startsWith("https://")) {
                results.set(result.sourceId, result.url);
              }
            },
            resolve
          );
        });
        promises.push(onlinePromise);
      }

      // race: wait up to 4s for the first result, then 2s more for higher-priority ones
      // skip entirely if we already have results and nothing async is pending
      if (promises.length === 0) {
        const best = pickBest();
        if (best) {
          this.coverCache.set(trackId, best);
          this.pruneCache();
        }
        return best || null;
      }

      await new Promise((resolve) => {
        let firstResultTimer = null;
        let finalTimer = null;

        const checkFirstResult = () => {
          if (results.size > 0 && !firstResultTimer) {
            // first result arrived => wait 2s more for higher-priority sources
            firstResultTimer = setTimeout(resolve, 2000);
          }
        };

        // poll for first result arrival
        const pollInterval = setInterval(() => {
          checkFirstResult();
          if (firstResultTimer) clearInterval(pollInterval);
        }, 100);

        // 4s total wait for first result
        finalTimer = setTimeout(() => {
          clearInterval(pollInterval);
          clearTimeout(firstResultTimer);
          resolve();
        }, 4000);

        // also resolve early if all sources report back
        Promise.all(promises).then(() => {
          clearInterval(pollInterval);
          clearTimeout(firstResultTimer);
          clearTimeout(finalTimer);
          resolve();
        });
      });

      const best = pickBest();
      if (best) {
        this.coverCache.set(trackId, best);
        this.pruneCache();
      }
      return best || null;
    },

    // Prune cover cache when it exceeds max size => remove oldest entries
    pruneCache() {
      if (this.coverCache.size > this.MAX_COVER_CACHE_SIZE) {
        const toRemove = this.coverCache.size - this.MAX_COVER_CACHE_SIZE;
        const keys = this.coverCache.keys();
        for (let i = 0; i < toRemove; i++) {
          this.coverCache.delete(keys.next().value);
        }
      }
    },

    // refresh cover art for the current track:
    // clears DB entry, in-memory cache, and re-runs cover resolution
    async refreshCover() {
      const track = this.currentTrack;
      if (!track?.id) return;

      try {
        // clear DB entry so backend re-uploads
        await this.api.library.updateTrackCoverUrl(track.id, null);
        // clear in-memory cache
        this.coverCache.delete(track.id);
        // re-run presence => will resolve cover fresh
        await this.updatePresence(true);
      } catch (err) {
        console.error("[Discord RPC] Cover refresh failed:", err);
      }
    },

    // Clear Discord presence
    async clearPresence() {
      if (!this.isConnected) return;

      try {
        await this.api.discord.clearPresence();
      } catch (error) {
        console.error("[Discord RPC] Clear failed:", error);
      }
    },

    // Lifecycle: required by Audion plugin API
    start() {},

    // Lifecycle: clear presence and timers on stop
    stop() {
      this.clearPresence();

      if (this.updateTimeout) {
        clearTimeout(this.updateTimeout);
        this.updateTimeout = null;
      }

      if (this.activityClearTimeout) {
        clearTimeout(this.activityClearTimeout);
        this.activityClearTimeout = null;
      }

      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
    },

    // Lifecycle: disconnect and remove DOM elements
    destroy() {
      this.disconnect();

      if (this.updateTimeout) {
        clearTimeout(this.updateTimeout);
      }

      if (this.activityClearTimeout) {
        clearTimeout(this.activityClearTimeout);
      }

      if (this.connectionStatusInterval) {
        clearInterval(this.connectionStatusInterval);
      }

      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
      }

      const modal = document.getElementById("drpc-modal");
      const overlay = document.getElementById("drpc-overlay");
      const style = document.getElementById("drpc-styles");

      if (modal) modal.remove();
      if (overlay) overlay.remove();
      if (style) style.remove();
    },
  };

  if (typeof Audion !== "undefined" && Audion.register) {
    Audion.register(DiscordRPC);
  } else {
    window.DiscordRichPresence = DiscordRPC;
    window.AudionPlugin = DiscordRPC;
  }
})();
