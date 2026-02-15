/**
 * Admin Panel JavaScript
 * 
 * Handles all admin interface interactions.
 */

const admin = {
  token: null,
  currentSection: 'dashboard',
  currentGame: null,
  games: [],
  gamesPage: 1,
  gamesLimit: 20,
  currentResourcesFilter: null,
  dragState: null,
  resourceModalState: null,
  resourceModalTranslations: {},
  dashboardStats: null,
  syncHistory: [],
  players: [],
  playersPage: 1,
  
  // ==================== INITIALIZATION ====================
  
  init() {
    // Check for existing session
    this.token = localStorage.getItem('adminToken');
    
    if (this.token) {
      this.checkSession();
    }
    
    // Setup event listeners
    this.setupEventListeners();
  },
  
  setupEventListeners() {
    // Login form
    document.getElementById('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.login();
    });
    
    // Logout button
    document.getElementById('logout-btn').addEventListener('click', () => {
      this.logout();
    });
    
    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const section = item.dataset.section;
        this.navigateTo(section);
      });
    });
    
    // Games search
    document.getElementById('games-search').addEventListener('input', 
      this.debounce(() => this.loadGames(1), 300)
    );
    
    document.getElementById('games-filter-enabled').addEventListener('change', 
      () => this.loadGames(1)
    );
    
    // Games per page
    document.getElementById('games-limit').addEventListener('change', (e) => {
      this.gamesLimit = e.target.value === 'all' ? 'all' : parseInt(e.target.value);
      this.loadGames(1);
    });
    
    // Resources game select
    document.getElementById('resources-game-select').addEventListener('change', (e) => {
      if (e.target.value) {
        this.loadGameResources(e.target.value);
      } else {
        document.getElementById('resources-editor').style.display = 'none';
        document.getElementById('resources-placeholder').style.display = 'block';
      }
    });
    
    // Game form tabs
    document.querySelectorAll('.form-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.switchFormTab(tab.dataset.tab);
      });
    });
    
    // Game form submit
    document.getElementById('game-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveGame();
    });
  },
  
  // ==================== AUTH ====================
  
  async login() {
    const tokenInput = document.getElementById('admin-token');
    const errorEl = document.getElementById('login-error');
    const submitBtn = document.querySelector('#login-form button[type="submit"]');
    
    submitBtn.querySelector('.btn-text').style.display = 'none';
    submitBtn.querySelector('.btn-loading').style.display = 'inline';
    submitBtn.disabled = true;
    errorEl.style.display = 'none';
    
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput.value })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Login failed');
      }
      
      this.token = data.token;
      localStorage.setItem('adminToken', this.token);
      
      this.showApp();
      this.loadDashboard();
      
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.style.display = 'block';
    } finally {
      submitBtn.querySelector('.btn-text').style.display = 'inline';
      submitBtn.querySelector('.btn-loading').style.display = 'none';
      submitBtn.disabled = false;
      tokenInput.value = '';
    }
  },
  
  async checkSession() {
    try {
      const response = await fetch('/api/admin/session', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (response.ok) {
        this.showApp();
        this.loadDashboard();
      } else {
        this.logout(false);
      }
    } catch (error) {
      this.logout(false);
    }
  },
  
  async logout(callApi = true) {
    if (callApi && this.token) {
      try {
        await fetch('/api/admin/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
      } catch (e) {
        // Ignore
      }
    }
    
    this.token = null;
    localStorage.removeItem('adminToken');
    
    document.getElementById('admin-app').style.display = 'none';
    document.getElementById('login-modal').style.display = 'flex';
  },
  
  showApp() {
    document.getElementById('login-modal').style.display = 'none';
    document.getElementById('admin-app').style.display = 'flex';
  },
  
  // ==================== NAVIGATION ====================
  
  navigateTo(section) {
    this.currentSection = section;
    
    // Update nav
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.section === section);
    });
    
    // Update sections
    document.querySelectorAll('.admin-section').forEach(sec => {
      sec.classList.toggle('active', sec.id === `section-${section}`);
    });
    
    // Load section data
    switch (section) {
      case 'dashboard':
        this.loadDashboard();
        break;
      case 'games':
        this.loadGames();
        break;
      case 'resources':
        this.loadGamesForSelect();
        break;
      case 'sync':
        this.loadSyncGames();
        this.loadSyncHistory();
        break;
      case 'players':
        this.loadPlayers();
        break;
      case 'statistics':
        this.loadStatistics();
        break;
      case 'monitoring':
        this.loadMonitoring();
        break;
    }
  },
  
  // ==================== DASHBOARD ====================
  
  async loadDashboard() {
    try {
      const response = await fetch('/api/admin/stats', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) throw new Error('Failed to load stats');
      
      const stats = await response.json();
      
      document.getElementById('stat-games').textContent = stats.games.enabled;
      document.getElementById('stat-races').textContent = this.formatNumber(stats.races);
      document.getElementById('stat-tournaments').textContent = this.formatNumber(stats.tournaments);
      document.getElementById('stat-players').textContent = this.formatNumber(stats.players);
      
      // Store stats for filtering
      this.dashboardStats = stats;
      
      // Alerts
      const alertsEl = document.getElementById('dashboard-alerts');
      let alertsHtml = '';
      
      if (stats.games.needingResources > 0) {
        alertsHtml += `
          <div class="alert alert-warning">
            <span class="alert-icon">⚠️</span>
            <span class="alert-text">${stats.games.needingResources} jeu(x) sans site officiel configuré</span>
            <button class="btn btn-sm btn-outline" onclick="admin.navigateToResourcesWithFilter('no-official-site')">Configurer</button>
          </div>
        `;
      }
      
      if (stats.games.needingOfficialSite > 0) {
        alertsHtml += `
          <div class="alert alert-info">
            <span class="alert-icon">ℹ️</span>
            <span class="alert-text">${stats.games.needingOfficialSite} jeu(x) avec plusieurs sites (site officiel à définir)</span>
            <button class="btn btn-sm btn-outline" onclick="admin.navigateToResourcesWithFilter('multiple-sites')">Voir</button>
          </div>
        `;
      }
      
      alertsEl.innerHTML = alertsHtml;
      
    } catch (error) {
      console.error('Error loading dashboard:', error);
      this.showToast('Erreur lors du chargement', 'error');
    }
  },
  
  // Navigate to resources with a specific filter
  navigateToResourcesWithFilter(filter) {
    this.currentResourcesFilter = filter;
    this.navigateTo('resources');
  },
  
  // ==================== GAMES ====================
  
  async loadGames(page) {
    if (page !== undefined) this.gamesPage = page;
    
    try {
      const search = document.getElementById('games-search').value;
      const enabled = document.getElementById('games-filter-enabled').value;
      const limit = this.gamesLimit === 'all' ? 9999 : this.gamesLimit;
      
      const params = new URLSearchParams({ page: this.gamesPage, limit });
      if (search) params.append('search', search);
      if (enabled) params.append('enabled', enabled);
      
      const response = await fetch(`/api/admin/games?${params}`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) throw new Error('Failed to load games');
      
      const data = await response.json();
      this.games = data.games;
      
      this.renderGamesTable(data.games);
      this.renderPagination(data.pagination, 'games');
      
    } catch (error) {
      console.error('Error loading games:', error);
      this.showToast('Erreur lors du chargement des jeux', 'error');
    }
  },
  
  renderGamesTable(games) {
    const tbody = document.getElementById('games-table-body');
    
    if (games.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center text-muted">Aucun jeu trouvé</td>
        </tr>
      `;
      return;
    }
    
    tbody.innerHTML = games.map(game => {
      const hasRacetime = game.integrations?.racetime?.enabled;
      const racetimeSlug = game.integrations?.racetime?.gameSlug || '-';
      const hasOfficialSite = game.resources?.officialSite?.url || game.resources?.sites?.length > 0;
      const sitesCount = game.resources?.sites?.length || 0;
      
      return `
        <tr>
          <td><code>${game.id}</code></td>
          <td>${this.escapeHtml(game.name)}</td>
          <td>${this.escapeHtml(game.randomizer?.shortName || game.name)}</td>
          <td>
            ${hasRacetime 
              ? `<span class="badge badge-success" title="${racetimeSlug}">✓ ${racetimeSlug}</span>` 
              : '<span class="badge badge-muted">-</span>'}
          </td>
          <td>
            ${hasOfficialSite 
              ? `<span class="badge badge-success">${sitesCount} site(s)</span>` 
              : '<span class="badge badge-warning">Aucun</span>'}
          </td>
          <td>
            ${game.enabled !== false 
              ? '<span class="badge badge-success">Activé</span>' 
              : '<span class="badge badge-danger">Désactivé</span>'}
          </td>
          <td>
            <button class="btn btn-sm btn-ghost" onclick="admin.editGame('${game.id}')" title="Modifier">
              ✏️
            </button>
            <button class="btn btn-sm btn-ghost" onclick="admin.viewGameResources('${game.id}')" title="Ressources">
              📚
            </button>
            ${hasRacetime 
              ? `<button class="btn btn-sm btn-ghost" onclick="admin.triggerFullResync('${game.id}', '${racetimeSlug}')" title="Resync complète des races (racetime)">
              🔄
            </button>` 
              : ''}
            <button class="btn btn-sm btn-ghost" onclick="admin.showMergeGameModal('${game.id}')" title="Fusionner avec un autre jeu">
              🔀
            </button>
            <button class="btn btn-sm btn-ghost btn-danger" onclick="admin.deleteGame('${game.id}')" title="Supprimer">
              🗑️
            </button>
          </td>
        </tr>
      `;
    }).join('');
  },
  
  renderPagination(pagination, type) {
    const container = document.getElementById(`${type}-pagination`);
    
    if (pagination.pages <= 1 && this.gamesLimit !== 'all') {
      container.innerHTML = pagination.total > 0 ? `<div class="pagination-buttons"><span class="pagination-info">${pagination.total} résultat(s)</span></div>` : '';
      return;
    }
    
    let html = '<div class="pagination-buttons">';
    
    if (pagination.page > 1) {
      html += `<button class="btn btn-sm btn-outline" onclick="admin.load${this.capitalize(type)}(${pagination.page - 1})">←</button>`;
    }
    
    html += `<span class="pagination-info">Page ${pagination.page} / ${pagination.pages} (${pagination.total} résultats)</span>`;
    
    if (pagination.page < pagination.pages) {
      html += `<button class="btn btn-sm btn-outline" onclick="admin.load${this.capitalize(type)}(${pagination.page + 1})">→</button>`;
    }
    
    html += '</div>';
    container.innerHTML = html;
  },
  
  showNewGameModal() {
    this.currentGame = null;
    document.getElementById('game-modal-title').textContent = 'Nouveau jeu';
    document.getElementById('game-form').reset();
    document.getElementById('game-id').disabled = false;
    document.getElementById('game-modal').style.display = 'flex';
    this.switchFormTab('basic');
  },
  
  async editGame(gameId) {
    try {
      const response = await fetch(`/api/admin/games/${gameId}`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) throw new Error('Failed to load game');
      
      const game = await response.json();
      this.currentGame = game;
      
      document.getElementById('game-modal-title').textContent = `Modifier: ${game.name}`;
      document.getElementById('game-id').value = game.id;
      document.getElementById('game-id').disabled = false;
      document.getElementById('game-name').value = game.name || '';
      document.getElementById('game-series').value = game.series || '';
      document.getElementById('game-enabled').value = game.enabled !== false ? 'true' : 'false';
      
      // Official
      document.getElementById('game-official-name').value = game.official?.name || '';
      document.getElementById('game-official-releaseYear').value = game.official?.releaseYear || '';
      document.getElementById('game-platforms').value = (game.platforms || []).join(', ');
      
      // Randomizer
      document.getElementById('game-randomizer-displayName').value = game.randomizer?.displayName || '';
      document.getElementById('game-randomizer-shortName').value = game.randomizer?.shortName || '';
      document.getElementById('game-randomizer-tinyName').value = game.randomizer?.tinyName || '';
      document.getElementById('game-randomizer-website').value = game.randomizer?.website || '';
      document.getElementById('game-randomizer-opensource').checked = game.randomizer?.opensource || false;
      
      // Integrations
      document.getElementById('game-racetime-enabled').checked = game.integrations?.racetime?.enabled || false;
      document.getElementById('game-racetime-slug').value = game.integrations?.racetime?.gameSlug || '';
      document.getElementById('game-randolist-enabled').checked = game.integrations?.randoList?.enabled || false;
      document.getElementById('game-randolist-identifier').value = game.integrations?.randoList?.randomizerIdentifier || '';
      
      document.getElementById('game-modal').style.display = 'flex';
      this.switchFormTab('basic');
      
    } catch (error) {
      console.error('Error loading game:', error);
      this.showToast('Erreur lors du chargement du jeu', 'error');
    }
  },
  
  closeGameModal() {
    document.getElementById('game-modal').style.display = 'none';
    this.currentGame = null;
  },
  
  switchFormTab(tabName) {
    document.querySelectorAll('.form-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    document.querySelectorAll('.form-tab-content').forEach(content => {
      content.classList.toggle('active', content.id === `form-tab-${tabName}`);
    });
  },
  
  async saveGame() {
    const form = document.getElementById('game-form');
    const formData = new FormData(form);
    
    // Build nested object
    const data = {
      id: formData.get('id'),
      name: formData.get('name'),
      series: formData.get('series') || undefined,
      enabled: formData.get('enabled') === 'true',
      official: {
        name: formData.get('official.name') || undefined,
        releaseYear: formData.get('official.releaseYear') ? parseInt(formData.get('official.releaseYear')) : undefined
      },
      platforms: formData.get('platforms') ? formData.get('platforms').split(',').map(p => p.trim()).filter(Boolean) : undefined,
      randomizer: {
        displayName: formData.get('randomizer.displayName') || undefined,
        shortName: formData.get('randomizer.shortName'),
        tinyName: formData.get('randomizer.tinyName') || undefined,
        website: formData.get('randomizer.website') || undefined,
        opensource: document.getElementById('game-randomizer-opensource').checked
      },
      integrations: {
        racetime: {
          enabled: document.getElementById('game-racetime-enabled').checked,
          gameSlug: formData.get('integrations.racetime.gameSlug') || undefined
        },
        randoList: {
          enabled: document.getElementById('game-randolist-enabled').checked,
          randomizerIdentifier: formData.get('integrations.randoList.randomizerIdentifier') || undefined
        }
      }
    };
    
    try {
      const isNew = !this.currentGame;
      
      // Handle ID change for existing games
      if (!isNew && data.id !== this.currentGame.id) {
        const changeIdResponse = await fetch(`/api/admin/games/${this.currentGame.id}/change-id`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.token}`
          },
          body: JSON.stringify({ newId: data.id })
        });
        
        if (!changeIdResponse.ok) {
          const error = await changeIdResponse.json();
          throw new Error(error.error || 'Échec du changement d\'ID');
        }
        
        // Update currentGame reference to new ID for the PUT
        this.currentGame.id = data.id;
      }
      
      const url = isNew ? '/api/admin/games' : `/api/admin/games/${this.currentGame.id}`;
      const method = isNew ? 'POST' : 'PUT';
      
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(data)
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save game');
      }
      
      this.showToast(isNew ? 'Jeu créé avec succès' : 'Jeu mis à jour', 'success');
      this.closeGameModal();
      // Stay on current page after save
      this.loadGames();
      
    } catch (error) {
      console.error('Error saving game:', error);
      this.showToast(error.message, 'error');
    }
  },
  
  viewGameResources(gameId) {
    this.currentResourcesFilter = null;
    this.navigateTo('resources');
    document.getElementById('resources-game-select').value = gameId;
    this.loadGameResources(gameId);
  },
  
  // ==================== RESOURCES ====================
  
  async loadGamesForSelect() {
    try {
      const response = await fetch('/api/admin/games?limit=200', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) throw new Error('Failed to load games');
      
      const data = await response.json();
      
      // Store games for filtering
      this.allGamesForResources = data.games.filter(g => g.enabled !== false);
      
      const select = document.getElementById('resources-game-select');
      const filterSelect = document.getElementById('resources-filter');
      const currentValue = select.value;
      
      // Apply filter if coming from dashboard
      let filteredGames = this.allGamesForResources;
      if (this.currentResourcesFilter === 'no-official-site') {
        filteredGames = filteredGames.filter(g => 
          !g.resources?.officialSite?.url
        );
        if (filterSelect) filterSelect.value = 'no-official-site';
      } else if (this.currentResourcesFilter === 'multiple-sites') {
        filteredGames = filteredGames.filter(g => 
          (g.resources?.sites?.length > 1) && !g.resources?.officialSite?.url
        );
        if (filterSelect) filterSelect.value = 'multiple-sites';
      }
      
      select.innerHTML = '<option value="">Sélectionner un jeu...</option>' +
        filteredGames
          .map(g => {
            const hasSite = g.resources?.officialSite?.url;
            const sitesCount = g.resources?.sites?.length || 0;
            let status = hasSite ? '✓' : (sitesCount > 1 ? `⚠️ ${sitesCount} sites` : '✗');
            return `<option value="${g.id}">${g.name} [${status}]</option>`;
          })
          .join('');
      
      // Update games count in filter section
      const gamesCountEl = document.getElementById('resources-games-count');
      if (gamesCountEl) {
        gamesCountEl.textContent = `${filteredGames.length} jeux`;
      }
      
      if (currentValue && filteredGames.find(g => g.id === currentValue)) {
        select.value = currentValue;
      }
      
      // Clear filter after applying
      this.currentResourcesFilter = null;
      
    } catch (error) {
      console.error('Error loading games for select:', error);
    }
  },
  
  applyResourcesFilter(filter) {
    this.currentResourcesFilter = filter || null;
    this.loadGamesForSelect();
  },
  
  async loadGameResources(gameId) {
    try {
      const response = await fetch(`/api/admin/games/${gameId}/resources`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) throw new Error('Failed to load resources');
      
      const data = await response.json();
      this.currentGame = { id: gameId, resources: data.resources };
      
      document.getElementById('resources-placeholder').style.display = 'none';
      document.getElementById('resources-editor').style.display = 'block';
      
      this.renderResources(data);
      
    } catch (error) {
      console.error('Error loading resources:', error);
      this.showToast('Erreur lors du chargement des ressources', 'error');
    }
  },

  async replaceResources(resourcesPayload, successMsg = 'Ressources mises à jour', errorMsg = 'Erreur lors de la mise à jour') {
    const response = await fetch(`/api/admin/games/${this.currentGame.id}/resources`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify(resourcesPayload)
    });

    if (!response.ok) {
      throw new Error('Failed to replace resources');
    }

    this.showToast(successMsg, 'success');
    this.loadGameResources(this.currentGame.id);
  },

  attachResourceDnD(listId, resourceType) {
    const container = document.getElementById(listId);
    if (!container) return;

    const items = container.querySelectorAll('.resource-item[data-resource-index]');
    items.forEach(item => {
      item.setAttribute('draggable', 'true');
      item.addEventListener('dragstart', (e) => {
        const idx = Number(item.dataset.resourceIndex);
        this.dragState = { resourceType, fromIndex: idx };
        item.classList.add('resource-item-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', `${resourceType}:${idx}`);
        }
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('resource-item-dragging');
      });
    });

    if (container.dataset.dndBound !== 'true') {
      container.dataset.dndBound = 'true';

      container.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      });

      container.addEventListener('drop', async (e) => {
        e.preventDefault();
        if (!this.dragState || this.dragState.resourceType !== resourceType) return;

        const targetItem = e.target.closest('.resource-item[data-resource-index]');
        const toIndex = targetItem ? Number(targetItem.dataset.resourceIndex) : null;
        const fromIndex = this.dragState.fromIndex;
        this.dragState = null;

        if (toIndex === null || Number.isNaN(fromIndex) || Number.isNaN(toIndex) || fromIndex === toIndex) return;

        try {
          await this.reorderResourceList(resourceType, fromIndex, toIndex);
        } catch (error) {
          this.showToast('Erreur lors du réordonnancement', 'error');
        }
      });
    }
  },

  async reorderResourceList(resourceType, fromIndex, toIndex) {
    const keyMap = {
      sites: 'sites',
      trackers: 'trackers',
      guides: 'guides',
      other: 'other'
    };
    const key = keyMap[resourceType];
    if (!key) return;

    const list = [...(this.currentGame.resources[key] || [])];
    if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) return;

    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);

    const payload = {
      ...this.currentGame.resources,
      [key]: list
    };

    await this.replaceResources(payload, 'Ordre mis à jour');
  },

  renderAdminAssetIcon(src, alt) {
    return `<img src="${src}" alt="${this.escapeHtml(alt || '')}">`;
  },

  getAdminSiteIcon(site = {}) {
    const url = String(site.url || '').toLowerCase();
    const name = String(site.name || '').toLowerCase();
    if (site.isArchipelago || url.includes('archipelago.gg') || name.includes('archipelago')) {
      return this.renderAdminAssetIcon('/assets/archipelago.png', 'Archipelago');
    }
    if (site.isMultiworld || url.includes('multiworld.gg') || name.includes('multiworld')) {
      return this.renderAdminAssetIcon('/assets/multiworld.png', 'Multiworld');
    }
    return '🔗';
  },

  getAdminOtherIcon(link = {}) {
    const type = String(link.type || '').toLowerCase();
    if (type === 'discord') {
      return this.renderAdminAssetIcon('/assets/discord.svg', 'Discord');
    }
    return type === 'community' ? '👥' : (type === 'seed' ? '🎲' : '🔗');
  },
  
  renderResources(data) {
    const resources = data.resources || {};
    
    // Official site
    const officialDisplay = document.getElementById('official-site-display');
    if (resources.officialSite?.url) {
      officialDisplay.innerHTML = `
        <div class="resource-item resource-item-primary">
          <span class="resource-icon">${this.getAdminSiteIcon(resources.officialSite)}</span>
          <a href="${resources.officialSite.url}" target="_blank" class="resource-link">
            ${this.escapeHtml(resources.officialSite.name || 'Site officiel')}
          </a>
          <button class="btn btn-sm btn-ghost btn-danger" onclick="admin.removeOfficialSite()">×</button>
        </div>
      `;
    } else {
      officialDisplay.innerHTML = '<p class="text-muted">Aucun site officiel défini</p>';
    }
    
    // Sites from rando-list
    const sitesList = document.getElementById('sites-list');
    if (resources.sites?.length > 0) {
      sitesList.innerHTML = resources.sites.map((site, i) => `
        <div class="resource-item ${site.isObsolete ? 'resource-item-obsolete' : ''}" data-resource-type="sites" data-resource-index="${i}">
          <span class="resource-icon">${this.getAdminSiteIcon(site)}</span>
          <div class="resource-details">
            <a href="${site.url}" target="_blank" class="resource-link">
              ${this.escapeHtml(site.name || site.url)}
            </a>
            ${site.description ? `<span class="resource-desc">${this.escapeHtml(site.description)}</span>` : ''}
          </div>
          ${resources.officialSite?.url === site.url ? '<span class="resource-type">officiel</span>' : ''}
          <span class="resource-source">${this.escapeHtml(site.source || 'manual')}</span>
          <button class="btn btn-sm btn-ghost" onclick="admin.openResourceModal('site', ${i})" title="Modifier">✏️</button>
          <button class="btn btn-sm btn-ghost btn-danger" onclick="admin.removeSite(${i})" title="Supprimer">×</button>
        </div>
      `).join('');
      this.attachResourceDnD('sites-list', 'sites');
    } else {
      sitesList.innerHTML = '<p class="text-muted">Aucun site</p>';
    }
    
    // Trackers
    const trackersList = document.getElementById('trackers-list');
    if (resources.trackers?.length > 0) {
      trackersList.innerHTML = resources.trackers.map((tracker, i) => `
        <div class="resource-item" data-resource-type="trackers" data-resource-index="${i}">
          <span class="resource-icon">📍</span>
          <div class="resource-details">
            <a href="${tracker.url}" target="_blank" class="resource-link">${this.escapeHtml(tracker.name)}</a>
            ${tracker.description ? `<span class="resource-desc">${this.escapeHtml(tracker.description)}</span>` : ''}
          </div>
          <span class="resource-source">${this.escapeHtml(tracker.source || 'manual')}</span>
          <button class="btn btn-sm btn-ghost" onclick="admin.openResourceModal('tracker', ${i})" title="Modifier">✏️</button>
          <button class="btn btn-sm btn-ghost btn-danger" onclick="admin.removeTracker(${i})">×</button>
        </div>
      `).join('');
      this.attachResourceDnD('trackers-list', 'trackers');
    } else {
      trackersList.innerHTML = '<p class="text-muted">Aucun tracker</p>';
    }
    
    // Guides
    const guidesList = document.getElementById('guides-list');
    if (resources.guides?.length > 0) {
      const typeIcons = { guide: '📖', tutorial: '🎓', wiki: '📝', video: '🎬' };
      guidesList.innerHTML = resources.guides.map((guide, i) => `
        <div class="resource-item" data-resource-type="guides" data-resource-index="${i}">
          <span class="resource-icon">${typeIcons[guide.type] || '📖'}</span>
          <div class="resource-details">
            <a href="${guide.url}" target="_blank" class="resource-link">${this.escapeHtml(guide.name)}</a>
            ${guide.description ? `<span class="resource-desc">${this.escapeHtml(guide.description)}</span>` : ''}
          </div>
          <span class="resource-source">${this.escapeHtml(guide.source || 'manual')}</span>
          <span class="resource-type">${guide.type}</span>
          <button class="btn btn-sm btn-ghost" onclick="admin.openResourceModal('guide', ${i})" title="Modifier">✏️</button>
          <button class="btn btn-sm btn-ghost btn-danger" onclick="admin.removeGuide(${i})">×</button>
        </div>
      `).join('');
      this.attachResourceDnD('guides-list', 'guides');
    } else {
      guidesList.innerHTML = '<p class="text-muted">Aucun guide</p>';
    }

    // Community / other links
    const otherLinksList = document.getElementById('other-links-list');
    if (otherLinksList) {
      if (resources.other?.length > 0) {
        otherLinksList.innerHTML = resources.other.map((link, i) => `
          <div class="resource-item" data-resource-type="other" data-resource-index="${i}">
            <span class="resource-icon">${this.getAdminOtherIcon(link)}</span>
            <div class="resource-details">
              <a href="${link.url}" target="_blank" class="resource-link">${this.escapeHtml(link.name || link.url)}</a>
              ${link.description ? `<span class="resource-desc">${this.escapeHtml(link.description)}</span>` : ''}
            </div>
            <span class="resource-source">${this.escapeHtml(link.source || 'manual')}</span>
            <span class="resource-type">${this.escapeHtml(link.type || 'resource')}</span>
            <button class="btn btn-sm btn-ghost" onclick="admin.openResourceModal('other', ${i})" title="Modifier">✏️</button>
            <button class="btn btn-sm btn-ghost btn-danger" onclick="admin.removeOtherLink(${i})">×</button>
          </div>
        `).join('');
        this.attachResourceDnD('other-links-list', 'other');
      } else {
        otherLinksList.innerHTML = '<p class="text-muted">Aucun lien communautaire / divers</p>';
      }
    }
  },

  openResourceModal(kind, index = null) {
    if (!this.currentGame) return;

    const isEdit = index !== null && index !== undefined;
    const resources = this.currentGame.resources || {};

    const modal = document.getElementById('resource-modal');
    const titleEl = document.getElementById('resource-modal-title');
    const deleteBtn = document.getElementById('resource-modal-delete');
    const typeGroup = document.getElementById('resource-modal-type-group');
    const sourceGroup = document.getElementById('resource-modal-source-group');
    const siteFlags = document.getElementById('resource-modal-site-flags');
    const siteOfficialGroup = document.getElementById('resource-modal-is-official-group');
    const i18nBlock = document.getElementById('resource-modal-i18n');
    const i18nNameGroup = document.getElementById('resource-modal-i18n-name-group');

    let item = null;
    if (kind === 'official') item = resources.officialSite || {};
    if (kind === 'site') item = (resources.sites || [])[index] || {};
    if (kind === 'tracker') item = (resources.trackers || [])[index] || {};
    if (kind === 'guide') item = (resources.guides || [])[index] || {};
    if (kind === 'other') item = (resources.other || [])[index] || {};

    this.resourceModalState = { kind, index, isEdit, lang: null };
    this.resourceModalTranslations = { ...(item.translations || {}) };

    titleEl.textContent = `${isEdit ? 'Modifier' : 'Ajouter'} ${kind === 'official' ? 'le site officiel' : kind}`;
    deleteBtn.style.display = isEdit ? 'inline-flex' : 'none';

    document.getElementById('resource-modal-url').value = item.url || '';
    document.getElementById('resource-modal-name').value = item.name || '';
    document.getElementById('resource-modal-description').value = item.description || '';
    document.getElementById('resource-modal-source').value = item.source || 'manual';

    const typeSelect = document.getElementById('resource-modal-type');
    if (kind === 'guide') {
      typeSelect.innerHTML = `
        <option value="guide">📖 Guide</option>
        <option value="tutorial">🎓 Tutoriel</option>
        <option value="wiki">📝 Wiki</option>
        <option value="video">🎬 Vidéo</option>
      `;
    } else if (kind === 'other') {
      typeSelect.innerHTML = `
        <option value="discord">💬 Discord</option>
        <option value="community">👥 Communauté</option>
        <option value="seed">🎲 Seed</option>
        <option value="resource">🔗 Ressource</option>
      `;
    }
    typeSelect.value = item.type || (kind === 'guide' ? 'guide' : 'resource');

    document.getElementById('resource-modal-is-archipelago').checked = !!item.isArchipelago;
    document.getElementById('resource-modal-is-multiworld').checked = !!item.isMultiworld;
    document.getElementById('resource-modal-is-obsolete').checked = !!item.isObsolete;
    document.getElementById('resource-modal-is-official').checked = kind === 'site' && (resources.officialSite?.url === item.url);

    if (document.getElementById('resource-modal-is-archipelago').checked && document.getElementById('resource-modal-is-multiworld').checked) {
      document.getElementById('resource-modal-is-multiworld').checked = false;
    }

    const archipelagoCheckbox = document.getElementById('resource-modal-is-archipelago');
    const multiworldCheckbox = document.getElementById('resource-modal-is-multiworld');
    archipelagoCheckbox.onchange = () => {
      if (archipelagoCheckbox.checked) multiworldCheckbox.checked = false;
    };
    multiworldCheckbox.onchange = () => {
      if (multiworldCheckbox.checked) archipelagoCheckbox.checked = false;
    };

    sourceGroup.style.display = (kind === 'official') ? 'none' : 'block';
    siteFlags.style.display = (kind === 'site') ? 'grid' : 'none';
    siteOfficialGroup.style.display = (kind === 'site') ? 'inline-flex' : 'none';
    typeGroup.style.display = (kind === 'guide' || kind === 'other') ? 'block' : 'none';
    i18nBlock.style.display = (kind === 'guide' || kind === 'other' || kind === 'tracker') ? 'block' : 'none';
    i18nNameGroup.style.display = (kind === 'tracker') ? 'none' : 'block';

    document.getElementById('resource-modal-lang').value = 'en';
    this.onResourceModalLanguageChange();

    modal.style.display = 'flex';
  },

  closeResourceModal() {
    document.getElementById('resource-modal').style.display = 'none';
    this.resourceModalState = null;
    this.resourceModalTranslations = {};
  },

  onResourceModalLanguageChange() {
    const previousLang = this.resourceModalState?.lang;
    if (previousLang) {
      this.persistCurrentResourceModalTranslation(previousLang);
    }
    const lang = document.getElementById('resource-modal-lang').value;
    if (this.resourceModalState) this.resourceModalState.lang = lang;
    const data = this.resourceModalTranslations?.[lang] || {};
    document.getElementById('resource-modal-i18n-name').value = data.name || '';
    document.getElementById('resource-modal-i18n-description').value = data.description || '';
  },

  persistCurrentResourceModalTranslation(forceLang = null) {
    if (!this.resourceModalState) return;
    const kind = this.resourceModalState.kind;
    if (!['guide', 'other', 'tracker'].includes(kind)) return;

    const lang = forceLang || this.resourceModalState.lang || document.getElementById('resource-modal-lang')?.value || 'en';
    const trName = document.getElementById('resource-modal-i18n-name')?.value.trim() || '';
    const trDesc = document.getElementById('resource-modal-i18n-description')?.value.trim() || '';

    const next = { ...(this.resourceModalTranslations || {}) };
    if (kind === 'tracker') {
      if (trDesc) {
        next[lang] = { ...(next[lang] || {}), description: trDesc };
      } else {
        const existing = { ...(next[lang] || {}) };
        delete existing.description;
        if (Object.keys(existing).length === 0) delete next[lang];
        else next[lang] = existing;
      }
    } else if (trName || trDesc) {
      next[lang] = { name: trName, description: trDesc };
    } else {
      delete next[lang];
    }

    this.resourceModalTranslations = next;
  },

  collectResourceModalTranslations() {
    this.persistCurrentResourceModalTranslation();

    const kind = this.resourceModalState?.kind;
    const translations = { ...(this.resourceModalTranslations || {}) };
    if (kind === 'tracker') {
      Object.keys(translations).forEach((lang) => {
        const data = translations[lang] || {};
        const desc = (data.description || '').trim();
        if (!desc) {
          delete translations[lang];
        } else {
          translations[lang] = { description: desc };
        }
      });
    }
    return translations;
  },

  async saveResourceModal() {
    if (!this.resourceModalState || !this.currentGame) return;

    const { kind, index, isEdit } = this.resourceModalState;
    const url = document.getElementById('resource-modal-url').value.trim();
    const name = document.getElementById('resource-modal-name').value.trim();
    const description = document.getElementById('resource-modal-description').value.trim();
    const source = document.getElementById('resource-modal-source').value;
    const type = document.getElementById('resource-modal-type').value;
    const isArchipelago = document.getElementById('resource-modal-is-archipelago').checked;
    const isMultiworld = document.getElementById('resource-modal-is-multiworld').checked;
    const isObsolete = document.getElementById('resource-modal-is-obsolete').checked;
    const isOfficial = document.getElementById('resource-modal-is-official').checked;

    if (!url || !name) {
      this.showToast('URL et titre requis', 'error');
      return;
    }

    try {
      const resources = this.currentGame.resources || {};

      if (kind === 'official') {
        await this.replaceResources({
          ...resources,
          officialSite: { url, name, isArchipelago }
        }, 'Site officiel mis à jour');
        this.closeResourceModal();
        return;
      }

      const keyMap = { site: 'sites', tracker: 'trackers', guide: 'guides', other: 'other' };
      const key = keyMap[kind];
      if (!key) return;

      const list = [...(resources[key] || [])];
      const previousItem = isEdit ? { ...(list[index] || {}) } : null;
      const payload = { url, name, description, source };
      if (kind === 'site') {
        if (isArchipelago && isMultiworld) {
          this.showToast('Archipelago et Multiworld ne peuvent pas être cochés ensemble', 'error');
          return;
        }
        payload.isArchipelago = isArchipelago;
        payload.isMultiworld = isMultiworld;
        payload.isObsolete = isObsolete;
      }
      if (kind === 'guide' || kind === 'other' || kind === 'tracker') {
        payload.type = type;
        payload.translations = this.collectResourceModalTranslations();
        if (kind === 'guide' && !['guide', 'tutorial', 'wiki', 'video'].includes(payload.type)) {
          this.showToast('Type de guide invalide', 'error');
          return;
        }
        if (kind === 'other' && !['discord', 'community', 'seed', 'resource'].includes(payload.type)) {
          this.showToast('Type de lien invalide', 'error');
          return;
        }
        if (kind === 'tracker') {
          delete payload.type;
        }
      }

      if (isEdit) {
        list[index] = { ...list[index], ...payload };
      } else {
        list.push(payload);
      }

      const nextResources = {
        ...resources,
        [key]: list
      };

      if (kind === 'site') {
        const previousUrl = previousItem?.url || '';
        const wasOfficial = isEdit && !!previousUrl && resources.officialSite?.url === previousUrl;
        if (isOfficial) {
          nextResources.officialSite = {
            url: payload.url,
            name: payload.name || 'Site officiel',
            isArchipelago: !!payload.isArchipelago,
            isMultiworld: !!payload.isMultiworld
          };
        } else if (wasOfficial) {
          nextResources.officialSite = null;
        }
      }

      await this.replaceResources(nextResources, 'Ressource mise à jour');

      this.closeResourceModal();
    } catch (error) {
      this.showToast('Erreur lors de la sauvegarde', 'error');
    }
  },

  async deleteResourceModal() {
    if (!this.resourceModalState || !this.resourceModalState.isEdit || !this.currentGame) return;
    if (!confirm('Supprimer cette ressource ?')) return;

    const { kind, index } = this.resourceModalState;
    const resources = this.currentGame.resources || {};

    try {
      if (kind === 'official') {
        await this.replaceResources({
          ...resources,
          officialSite: null
        }, 'Site officiel supprimé');
        this.closeResourceModal();
        return;
      }

      const keyMap = { site: 'sites', tracker: 'trackers', guide: 'guides', other: 'other' };
      const key = keyMap[kind];
      if (!key) return;

      const list = [...(resources[key] || [])].filter((_, i) => i !== index);
      const nextResources = {
        ...resources,
        [key]: list
      };

      if (kind === 'site') {
        const removed = (resources.sites || [])[index];
        if (removed?.url && resources.officialSite?.url === removed.url) {
          nextResources.officialSite = null;
        }
      }

      await this.replaceResources(nextResources, 'Ressource supprimée');

      this.closeResourceModal();
    } catch (error) {
      this.showToast('Erreur lors de la suppression', 'error');
    }
  },

  async editSite(index) {
    this.openResourceModal('site', index);
  },
  
  async saveOfficialSite() {
    const url = document.getElementById('official-site-url').value.trim();
    const name = document.getElementById('official-site-name').value.trim();
    const isArchipelago = document.getElementById('official-site-archipelago').checked;
    
    if (!url) {
      this.showToast('URL requise', 'error');
      return;
    }
    
    try {
      const response = await fetch(`/api/admin/games/${this.currentGame.id}/resources/official-site`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ url, name: name || 'Site officiel', isArchipelago })
      });
      
      if (!response.ok) throw new Error('Failed to save');
      
      this.showToast('Site officiel enregistré', 'success');
      this.loadGameResources(this.currentGame.id);
      
      // Clear form
      document.getElementById('official-site-url').value = '';
      document.getElementById('official-site-name').value = '';
      document.getElementById('official-site-archipelago').checked = false;
      
    } catch (error) {
      this.showToast('Erreur lors de l\'enregistrement', 'error');
    }
  },
  
  async removeOfficialSite() {
    if (!confirm('Supprimer le site officiel ?')) return;
    
    try {
      const response = await fetch(`/api/admin/games/${this.currentGame.id}/resources`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ 
          ...this.currentGame.resources,
          officialSite: null 
        })
      });
      
      if (!response.ok) throw new Error('Failed to remove');
      
      this.showToast('Site officiel supprimé', 'success');
      this.loadGameResources(this.currentGame.id);
      
    } catch (error) {
      this.showToast('Erreur lors de la suppression', 'error');
    }
  },
  
  async setAsOfficialSite(siteIndex) {
    const site = this.currentGame.resources.sites[siteIndex];
    if (!site) return;
    
    try {
      const response = await fetch(`/api/admin/games/${this.currentGame.id}/resources/official-site`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ 
          url: site.url, 
          name: site.name || 'Site officiel', 
          isArchipelago: site.isArchipelago || false 
        })
      });
      
      if (!response.ok) throw new Error('Failed to set');
      
      this.showToast('Site officiel défini', 'success');
      this.loadGameResources(this.currentGame.id);
      
    } catch (error) {
      this.showToast('Erreur', 'error');
    }
  },

  async removeSite(index) {
    if (!confirm('Supprimer ce site ?')) return;

    try {
      const currentSites = this.currentGame?.resources?.sites || [];
      const nextSites = currentSites.filter((_, i) => i !== index);

      const removed = currentSites[index];
      const nextResources = {
        ...this.currentGame.resources,
        sites: nextSites
      };

      if (removed?.url && this.currentGame?.resources?.officialSite?.url === removed.url) {
        nextResources.officialSite = null;
      }

      await this.replaceResources(nextResources, 'Site supprimé');
    } catch (error) {
      this.showToast('Erreur lors de la suppression', 'error');
    }
  },
  
  async addTracker() {
    const url = document.getElementById('tracker-url').value.trim();
    const name = document.getElementById('tracker-name').value.trim();
    const description = document.getElementById('tracker-desc').value.trim();
    
    if (!url || !name) {
      this.showToast('URL et nom requis', 'error');
      return;
    }
    
    try {
      const response = await fetch(`/api/admin/games/${this.currentGame.id}/resources/trackers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ url, name, description })
      });
      
      if (!response.ok) throw new Error('Failed to add');
      
      this.showToast('Tracker ajouté', 'success');
      this.loadGameResources(this.currentGame.id);
      
      // Clear form
      document.getElementById('tracker-url').value = '';
      document.getElementById('tracker-name').value = '';
      document.getElementById('tracker-desc').value = '';
      
    } catch (error) {
      this.showToast('Erreur lors de l\'ajout', 'error');
    }
  },
  
  async removeTracker(index) {
    if (!confirm('Supprimer ce tracker ?')) return;
    
    try {
      const response = await fetch(`/api/admin/games/${this.currentGame.id}/resources/trackers/${index}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) throw new Error('Failed to remove');
      
      this.showToast('Tracker supprimé', 'success');
      this.loadGameResources(this.currentGame.id);
      
    } catch (error) {
      this.showToast('Erreur lors de la suppression', 'error');
    }
  },

  async editTracker(index) {
    this.openResourceModal('tracker', index);
  },
  
  async addGuide() {
    const url = document.getElementById('guide-url').value.trim();
    const name = document.getElementById('guide-name').value.trim();
    const type = document.getElementById('guide-type').value;
    const description = document.getElementById('guide-desc').value.trim();
    
    if (!url || !name) {
      this.showToast('URL et nom requis', 'error');
      return;
    }
    
    try {
      const response = await fetch(`/api/admin/games/${this.currentGame.id}/resources/guides`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ url, name, type, description })
      });
      
      if (!response.ok) throw new Error('Failed to add');
      
      this.showToast('Guide ajouté', 'success');
      this.loadGameResources(this.currentGame.id);
      
      // Clear form
      document.getElementById('guide-url').value = '';
      document.getElementById('guide-name').value = '';
      document.getElementById('guide-desc').value = '';
      
    } catch (error) {
      this.showToast('Erreur lors de l\'ajout', 'error');
    }
  },
  
  async removeGuide(index) {
    if (!confirm('Supprimer ce guide ?')) return;
    
    try {
      const response = await fetch(`/api/admin/games/${this.currentGame.id}/resources/guides/${index}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) throw new Error('Failed to remove');
      
      this.showToast('Guide supprimé', 'success');
      this.loadGameResources(this.currentGame.id);
      
    } catch (error) {
      this.showToast('Erreur lors de la suppression', 'error');
    }
  },

  async editGuide(index) {
    this.openResourceModal('guide', index);
  },

  async addOtherLink() {
    const url = document.getElementById('other-link-url')?.value.trim();
    const name = document.getElementById('other-link-name')?.value.trim();
    const type = document.getElementById('other-link-type')?.value || 'resource';
    const description = document.getElementById('other-link-desc')?.value.trim();

    if (!url || !name) {
      this.showToast('URL et nom requis', 'error');
      return;
    }

    try {
      const currentOther = this.currentGame.resources.other || [];
      const response = await fetch(`/api/admin/games/${this.currentGame.id}/resources`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({
          ...this.currentGame.resources,
          other: [...currentOther, { url, name, type, description, source: 'manual' }]
        })
      });

      if (!response.ok) throw new Error('Failed to add other link');

      this.showToast('Lien ajouté', 'success');
      this.loadGameResources(this.currentGame.id);

      document.getElementById('other-link-url').value = '';
      document.getElementById('other-link-name').value = '';
      document.getElementById('other-link-desc').value = '';
      document.getElementById('other-link-type').value = 'discord';
    } catch (error) {
      this.showToast('Erreur lors de l\'ajout', 'error');
    }
  },

  async removeOtherLink(index) {
    if (!confirm('Supprimer ce lien ?')) return;

    try {
      const currentOther = this.currentGame.resources.other || [];
      const nextOther = currentOther.filter((_, i) => i !== index);

      const response = await fetch(`/api/admin/games/${this.currentGame.id}/resources`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({
          ...this.currentGame.resources,
          other: nextOther
        })
      });

      if (!response.ok) throw new Error('Failed to remove other link');

      this.showToast('Lien supprimé', 'success');
      this.loadGameResources(this.currentGame.id);
    } catch (error) {
      this.showToast('Erreur lors de la suppression', 'error');
    }
  },

  async editOtherLink(index) {
    this.openResourceModal('other', index);
  },
  
  // ==================== MERGE GAMES ====================
  
  showMergeGameModal(gameId) {
    const game = this.games.find(g => g.id === gameId);
    if (!game) {
      this.showToast('Jeu non trouvé', 'error');
      return;
    }
    
    document.getElementById('merge-target-name').textContent = `${game.name} (${gameId})`;
    document.getElementById('merge-target-id').value = gameId;
    document.getElementById('merge-source-id').value = '';
    document.getElementById('merge-preview').style.display = 'none';
    document.getElementById('merge-confirm-btn').disabled = true;
    document.getElementById('merge-modal').style.display = 'flex';
  },
  
  closeMergeModal() {
    document.getElementById('merge-modal').style.display = 'none';
  },
  
  async previewMerge() {
    const targetId = document.getElementById('merge-target-id').value;
    const sourceId = document.getElementById('merge-source-id').value.trim();
    
    if (!sourceId) {
      this.showToast('Veuillez entrer l\'ID du jeu source', 'error');
      return;
    }
    
    if (sourceId === targetId) {
      this.showToast('Impossible de fusionner un jeu avec lui-même', 'error');
      return;
    }
    
    try {
      // Fetch both games
      const [targetResp, sourceResp] = await Promise.all([
        fetch(`/api/admin/games/${targetId}`, { headers: { 'Authorization': `Bearer ${this.token}` } }),
        fetch(`/api/admin/games/${sourceId}`, { headers: { 'Authorization': `Bearer ${this.token}` } })
      ]);
      
      if (!targetResp.ok) throw new Error('Jeu cible non trouvé');
      if (!sourceResp.ok) throw new Error(`Jeu source "${sourceId}" non trouvé`);
      
      const target = await targetResp.json();
      const source = await sourceResp.json();
      
      // Show preview
      const preview = document.getElementById('merge-preview');
      const sourceSites = source.resources?.sites?.length || 0;
      const sourceTrackers = source.resources?.trackers?.length || 0;
      const sourceGuides = source.resources?.guides?.length || 0;
      const sourceOfficialSite = source.resources?.officialSite?.url ? 1 : 0;
      
      const targetSites = target.resources?.sites?.length || 0;
      const targetTrackers = target.resources?.trackers?.length || 0;
      const targetGuides = target.resources?.guides?.length || 0;
      
      preview.innerHTML = `
        <div class="card mt-3">
          <h4 class="card-title">📋 Aperçu de la fusion</h4>
          <p><strong>Source :</strong> ${this.escapeHtml(source.name)} (<code>${sourceId}</code>)</p>
          <p><strong>Cible :</strong> ${this.escapeHtml(target.name)} (<code>${targetId}</code>)</p>
          <hr style="border-color: var(--admin-border); margin: 0.75rem 0;">
          <p class="text-muted" style="font-size: 0.875rem;">Ressources qui seront fusionnées :</p>
          <ul style="margin: 0.5rem 0; padding-left: 1.5rem; font-size: 0.875rem;">
            ${sourceOfficialSite ? `<li>Site officiel (sera ajouté si absent dans la cible)</li>` : ''}
            <li>${sourceSites} site(s) → ajoutés aux ${targetSites} existant(s)</li>
            <li>${sourceTrackers} tracker(s) → ajoutés aux ${targetTrackers} existant(s)</li>
            <li>${sourceGuides} guide(s) → ajoutés aux ${targetGuides} existant(s)</li>
          </ul>
          <p class="text-muted" style="font-size: 0.875rem;">
            ⚠️ Le jeu source <strong>${this.escapeHtml(source.name)}</strong> sera <strong>supprimé</strong> après la fusion.
            Les références (tournois, courses) seront mises à jour vers le jeu cible.
          </p>
        </div>
      `;
      preview.style.display = 'block';
      document.getElementById('merge-confirm-btn').disabled = false;
      
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  },
  
  async confirmMerge() {
    const targetId = document.getElementById('merge-target-id').value;
    const sourceId = document.getElementById('merge-source-id').value.trim();
    
    if (!confirm(`⚠️ Êtes-vous sûr de vouloir fusionner "${sourceId}" dans "${targetId}" ?\n\nLe jeu source sera supprimé. Cette action est irréversible.`)) {
      return;
    }
    
    try {
      const response = await fetch(`/api/admin/games/${targetId}/merge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ sourceId })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Échec de la fusion');
      }
      
      const result = await response.json();
      this.showToast(`Fusion réussie ! ${result.mergedResources || ''} ressource(s) fusionnée(s)`, 'success');
      this.closeMergeModal();
      this.loadGames();
      
    } catch (error) {
      console.error('Error merging games:', error);
      this.showToast(error.message, 'error');
    }
  },
  
  async deleteGame(gameId) {
    const game = this.games.find(g => g.id === gameId);
    const gameName = game ? game.name : gameId;
    
    if (!confirm(`⚠️ Êtes-vous sûr de vouloir supprimer le jeu "${gameName}" ?\n\nCette action est irréversible et supprimera toutes les données associées.`)) {
      return;
    }
    
    try {
      const response = await fetch(`/api/admin/games/${gameId}?hard=true`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Erreur lors de la suppression');
      }
      
      this.showToast(`Jeu "${gameName}" supprimé avec succès`, 'success');
      this.loadGames();
    } catch (error) {
      console.error('Error deleting game:', error);
      this.showToast(error.message, 'error');
    }
  },
  
  // ==================== SYNC ====================
  
  async loadSyncGames() {
    try {
      const response = await fetch('/api/admin/games?limit=200', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) throw new Error('Failed to load games');
      
      const data = await response.json();
      
      const select = document.getElementById('sync-racetime-game');
      select.innerHTML = '<option value="">Tous les jeux</option>' +
        data.games
          .filter(g => g.enabled !== false && g.integrations?.racetime?.enabled)
          .map(g => `<option value="${g.integrations.racetime.gameSlug}">${g.name}</option>`)
          .join('');
      
    } catch (error) {
      console.error('Error loading games for sync:', error);
    }
  },
  
  async triggerSync(type, linkGames = false) {
    try {
      const response = await fetch(`/api/admin/sync/${type}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ linkGames })
      });
      
      if (!response.ok) throw new Error('Failed to trigger sync');
      
      const data = await response.json();
      this.showToast(`Synchronisation lancée (PID: ${data.pid})`, 'success');
      
      // Add to log
      this.addSyncLog(`${type} sync started`, 'info');
      
    } catch (error) {
      this.showToast('Erreur lors du lancement de la synchronisation', 'error');
    }
  },
  
  async triggerRacetimeSync() {
    const gameSlug = document.getElementById('sync-racetime-game').value;
    
    try {
      const url = gameSlug 
        ? `/api/admin/sync/racetime/${gameSlug}`
        : '/api/admin/sync/racetime/all';
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ maxPages: 10 })
      });
      
      if (!response.ok) throw new Error('Failed to trigger sync');
      
      const data = await response.json();
      this.showToast(`Synchronisation racetime lancée`, 'success');
      this.addSyncLog(`Racetime sync started for ${gameSlug || 'all games'}`, 'info');
      
    } catch (error) {
      this.showToast('Erreur lors du lancement', 'error');
    }
  },
  
  async triggerFullResync(gameId, racetimeSlug) {
    if (!confirm(`Lancer une resynchronisation complète de toutes les races pour "${gameId}" (slug: ${racetimeSlug}) ?\n\nCela peut prendre plusieurs minutes.`)) {
      return;
    }
    
    try {
      this.showToast(`Resync lancée pour ${gameId}...`, 'info');
      
      const response = await fetch(`/api/admin/sync/racetime/${racetimeSlug}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ maxPages: 99999 })
      });
      
      if (!response.ok) throw new Error('Échec du lancement de la resync');
      
      this.showToast(`Resync complète lancée pour ${gameId} en arrière-plan`, 'success');
      this.addSyncLog(`🔄 Resync complète lancée: ${gameId} (${racetimeSlug})`, 'info');
      
    } catch (error) {
      console.error('Error triggering full resync:', error);
      this.showToast(`Erreur: ${error.message}`, 'error');
    }
  },

  addSyncLog(message, type = 'info') {
    const logContent = document.getElementById('sync-log-content');
    const timestamp = new Date().toLocaleTimeString();
    const typeColors = { info: '#60a5fa', success: '#10b981', error: '#ef4444' };
    
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    logEntry.innerHTML = `
      <span class="log-time">${timestamp}</span>
      <span class="log-message" style="color: ${typeColors[type]}">${message}</span>
    `;
    
    // Remove placeholder if present
    const placeholder = logContent.querySelector('.text-muted');
    if (placeholder) placeholder.remove();
    
    logContent.insertBefore(logEntry, logContent.firstChild);
  },
  
  // ==================== UTILITIES ====================
  
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    container.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('toast-fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },
  
  formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  },
  
  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },
  
  capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  },
  
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },
  
  formatDuration(ms) {
    if (!ms) return '-';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  },
  
  formatDateTime(date) {
    if (!date) return '-';
    const d = new Date(date);
    return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  },
  
  formatRelativeTime(date) {
    if (!date) return '-';
    const now = new Date();
    const diff = now - new Date(date);
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `il y a ${days}j`;
    if (hours > 0) return `il y a ${hours}h`;
    if (minutes > 0) return `il y a ${minutes}m`;
    return 'à l\'instant';
  },
  
  // ==================== SYNC HISTORY ====================
  
  async loadSyncHistory() {
    try {
      const response = await fetch('/api/admin/sync/history', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) {
        // API might not exist yet, show placeholder
        this.renderSyncHistory([]);
        return;
      }
      
      const data = await response.json();
      this.syncHistory = data.history || [];
      this.renderSyncHistory(this.syncHistory);
      
    } catch (error) {
      console.error('Error loading sync history:', error);
      this.renderSyncHistory([]);
    }
  },
  
  renderSyncHistory(history) {
    const container = document.getElementById('sync-history-content');
    if (!container) return;
    
    if (history.length === 0) {
      container.innerHTML = '<p class="text-muted">Aucun historique de synchronisation disponible</p>';
      return;
    }
    
    container.innerHTML = history.slice(0, 10).map(entry => `
      <div class="sync-history-item ${entry.status}">
        <div class="sync-history-header">
          <span class="sync-history-type">${this.escapeHtml(entry.type)}</span>
          <span class="sync-history-status badge badge-${entry.status === 'success' ? 'success' : entry.status === 'error' ? 'danger' : 'warning'}">
            ${entry.status === 'success' ? '✓' : entry.status === 'error' ? '✗' : '⏳'}
          </span>
        </div>
        <div class="sync-history-meta">
          <span>${this.formatRelativeTime(entry.completedAt || entry.startedAt)}</span>
          ${entry.itemsProcessed ? `<span>• ${entry.itemsProcessed} éléments</span>` : ''}
          ${entry.duration ? `<span>• ${this.formatDuration(entry.duration)}</span>` : ''}
        </div>
        ${entry.error ? `<div class="sync-history-error">${this.escapeHtml(entry.error)}</div>` : ''}
      </div>
    `).join('');
  },
  
  // ==================== PLAYERS ====================
  
  async loadPlayers(page = 1) {
    this.playersPage = page;
    
    try {
      const search = document.getElementById('players-search')?.value || '';
      
      const response = await fetch(`/api/admin/players?page=${page}&limit=50&search=${encodeURIComponent(search)}`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) throw new Error('Failed to load players');
      
      const data = await response.json();
      this.players = data.players;
      
      this.renderPlayersTable(data.players);
      this.renderPagination(data.pagination, 'players');
      
      // Update stats
      const statsEl = document.getElementById('players-stats');
      if (statsEl && data.stats) {
        statsEl.innerHTML = `
          <div class="stat-mini">
            <span class="stat-mini-value">${this.formatNumber(data.stats.total)}</span>
            <span class="stat-mini-label">Total</span>
          </div>
          <div class="stat-mini">
            <span class="stat-mini-value">${this.formatNumber(data.stats.withRacetime)}</span>
            <span class="stat-mini-label">Avec Racetime</span>
          </div>
          <div class="stat-mini">
            <span class="stat-mini-value">${this.formatNumber(data.stats.withTwitch)}</span>
            <span class="stat-mini-label">Avec Twitch</span>
          </div>
        `;
      }
      
    } catch (error) {
      console.error('Error loading players:', error);
      this.showToast('Erreur lors du chargement des joueurs', 'error');
    }
  },
  
  renderPlayersTable(players) {
    const tbody = document.getElementById('players-table-body');
    if (!tbody) return;
    
    if (players.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center text-muted">Aucun joueur trouvé</td>
        </tr>
      `;
      return;
    }
    
    tbody.innerHTML = players.map(player => `
      <tr>
        <td>${this.escapeHtml(player.name)}</td>
        <td>
          ${player.racetimeUrl 
            ? `<a href="${player.racetimeUrl}" target="_blank" class="badge badge-success">✓ Lié</a>` 
            : '<span class="badge badge-muted">-</span>'}
        </td>
        <td>
          ${player.twitch 
            ? `<a href="https://twitch.tv/${player.twitch}" target="_blank" class="badge badge-success">${this.escapeHtml(player.twitch)}</a>` 
            : '<span class="badge badge-muted">-</span>'}
        </td>
        <td>${player.stats?.totalRaces || 0}</td>
        <td>${player.stats?.totalWins || 0}</td>
        <td>
          <button class="btn btn-sm btn-ghost" onclick="admin.editPlayer('${this.escapeHtml(player.userId)}')" title="Modifier">
            ✏️
          </button>
        </td>
      </tr>
    `).join('');
  },
  
  async editPlayer(playerId) {
    try {
      const response = await fetch(`/api/admin/players/${playerId}`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) throw new Error('Player not found');
      
      const player = await response.json();
      
      document.getElementById('player-modal-title').textContent = `Modifier: ${player.name}`;
      document.getElementById('player-id').value = player.userId || player._id;
      document.getElementById('player-name').value = player.name || '';
      document.getElementById('player-racetime-url').value = player.racetimeUrl || '';
      document.getElementById('player-twitch').value = player.twitch || '';
      
      document.getElementById('player-modal').style.display = 'flex';
      
    } catch (error) {
      console.error('Error loading player:', error);
      this.showToast('Erreur lors du chargement du joueur', 'error');
    }
  },
  
  closePlayerModal() {
    document.getElementById('player-modal').style.display = 'none';
  },
  
  async savePlayer() {
    const playerId = document.getElementById('player-id').value;
    const data = {
      name: document.getElementById('player-name').value,
      racetimeUrl: document.getElementById('player-racetime-url').value,
      twitch: document.getElementById('player-twitch').value
    };
    
    try {
      const response = await fetch(`/api/admin/players/${playerId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(data)
      });
      
      if (!response.ok) throw new Error('Failed to save player');
      
      this.showToast('Joueur mis à jour', 'success');
      this.closePlayerModal();
      this.loadPlayers(this.playersPage);
      
    } catch (error) {
      console.error('Error saving player:', error);
      this.showToast('Erreur lors de la sauvegarde', 'error');
    }
  },
  
  // ==================== STATISTICS ====================
  
  async loadStatistics() {
    try {
      const response = await fetch('/api/admin/analytics', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      // Analytics might not be implemented yet
      if (!response.ok) {
        this.renderStatisticsPlaceholder();
        return;
      }
      
      const data = await response.json();
      this.renderStatistics(data);
      
    } catch (error) {
      console.error('Error loading statistics:', error);
      this.renderStatisticsPlaceholder();
    }
  },
  
  renderStatisticsPlaceholder() {
    const container = document.getElementById('statistics-content');
    if (!container) return;
    
    container.innerHTML = `
      <div class="placeholder-box">
        <div class="placeholder-icon">📊</div>
        <h3>Statistiques à venir</h3>
        <p class="text-muted">
          Les statistiques de visite seront disponibles une fois le site en ligne.<br>
          Intégration prévue : Google Analytics, Plausible ou Umami.
        </p>
        <div class="stats-preview">
          <div class="stat-preview-card">
            <span class="stat-preview-icon">👁️</span>
            <span class="stat-preview-label">Visites</span>
          </div>
          <div class="stat-preview-card">
            <span class="stat-preview-icon">📄</span>
            <span class="stat-preview-label">Pages vues</span>
          </div>
          <div class="stat-preview-card">
            <span class="stat-preview-icon">👤</span>
            <span class="stat-preview-label">Visiteurs uniques</span>
          </div>
          <div class="stat-preview-card">
            <span class="stat-preview-icon">⏱️</span>
            <span class="stat-preview-label">Durée moyenne</span>
          </div>
        </div>
      </div>
    `;
  },
  
  renderStatistics(data) {
    const container = document.getElementById('statistics-content');
    if (!container) return;
    
    container.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">👁️</div>
          <div>
            <div class="stat-value">${this.formatNumber(data.pageViews || 0)}</div>
            <div class="stat-label">Pages vues (30j)</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">👤</div>
          <div>
            <div class="stat-value">${this.formatNumber(data.uniqueVisitors || 0)}</div>
            <div class="stat-label">Visiteurs uniques</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">⏱️</div>
          <div>
            <div class="stat-value">${data.avgSessionDuration || '-'}</div>
            <div class="stat-label">Durée moyenne</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📈</div>
          <div>
            <div class="stat-value">${data.bounceRate || '-'}%</div>
            <div class="stat-label">Taux de rebond</div>
          </div>
        </div>
      </div>
      
      ${data.topPages ? `
        <div class="card mt-4">
          <h3 class="card-title">📄 Pages les plus vues</h3>
          <table class="table">
            <thead>
              <tr><th>Page</th><th>Vues</th></tr>
            </thead>
            <tbody>
              ${data.topPages.map(p => `
                <tr>
                  <td>${this.escapeHtml(p.path)}</td>
                  <td>${this.formatNumber(p.views)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}
    `;
  },
  
  // ==================== MONITORING ====================
  
  async loadMonitoring() {
    try {
      const response = await fetch('/api/admin/health', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) {
        this.renderMonitoringError();
        return;
      }
      
      const data = await response.json();
      this.renderMonitoring(data);
      
    } catch (error) {
      console.error('Error loading monitoring:', error);
      this.renderMonitoringError();
    }
  },
  
  renderMonitoringError() {
    const container = document.getElementById('monitoring-content');
    if (!container) return;
    
    container.innerHTML = `
      <div class="alert alert-danger">
        <span class="alert-icon">⚠️</span>
        <span class="alert-text">Impossible de charger les données de monitoring</span>
      </div>
    `;
  },
  
  renderMonitoring(data) {
    const container = document.getElementById('monitoring-content');
    if (!container) return;
    
    const getStatusClass = (status) => {
      if (status === 'ok' || status === 'online' || status === true) return 'success';
      if (status === 'warning') return 'warning';
      return 'danger';
    };
    
    const getStatusIcon = (status) => {
      if (status === 'ok' || status === 'online' || status === true) return '✓';
      if (status === 'warning') return '⚠️';
      return '✗';
    };
    
    container.innerHTML = `
      <div class="monitoring-grid">
        <!-- Services Status -->
        <div class="monitoring-card">
          <h3 class="monitoring-card-title">🔌 Services</h3>
          <div class="monitoring-items">
            <div class="monitoring-item">
              <span class="monitoring-label">API Randomizer</span>
              <span class="badge badge-${getStatusClass(data.api?.status)}">${getStatusIcon(data.api?.status)} ${data.api?.status || 'unknown'}</span>
            </div>
            <div class="monitoring-item">
              <span class="monitoring-label">MongoDB</span>
              <span class="badge badge-${getStatusClass(data.database?.status)}">${getStatusIcon(data.database?.status)} ${data.database?.status || 'unknown'}</span>
            </div>
            <div class="monitoring-item">
              <span class="monitoring-label">Racetime.gg</span>
              <span class="badge badge-${getStatusClass(data.racetime?.status)}">${getStatusIcon(data.racetime?.status)} ${data.racetime?.status || 'unknown'}</span>
            </div>
            <div class="monitoring-item">
              <span class="monitoring-label">Twitch API</span>
              <span class="badge badge-${getStatusClass(data.twitch?.status)}">${getStatusIcon(data.twitch?.status)} ${data.twitch?.status || 'unknown'}</span>
            </div>
            <div class="monitoring-item">
              <span class="monitoring-label">Challonge API</span>
              <span class="badge badge-${getStatusClass(data.challonge?.status)}">${getStatusIcon(data.challonge?.status)} ${data.challonge?.status || 'unknown'}</span>
            </div>
            <div class="monitoring-item">
              <span class="monitoring-label">start.gg API</span>
              <span class="badge badge-${getStatusClass(data.startgg?.status)}">${getStatusIcon(data.startgg?.status)} ${data.startgg?.status || 'unknown'}</span>
            </div>
          </div>
        </div>
        
        <!-- System Info -->
        <div class="monitoring-card">
          <h3 class="monitoring-card-title">💻 Système</h3>
          <div class="monitoring-items">
            <div class="monitoring-item">
              <span class="monitoring-label">Uptime</span>
              <span class="monitoring-value">${this.formatDuration((data.system?.uptime || 0) * 1000)}</span>
            </div>
            <div class="monitoring-item">
              <span class="monitoring-label">Mémoire</span>
              <span class="monitoring-value">${data.system?.memory?.used || '-'} / ${data.system?.memory?.total || '-'}</span>
            </div>
            <div class="monitoring-item">
              <span class="monitoring-label">Node.js</span>
              <span class="monitoring-value">${data.system?.nodeVersion || '-'}</span>
            </div>
          </div>
        </div>
        
        <!-- PM2 Status -->
        <div class="monitoring-card">
          <h3 class="monitoring-card-title">⚙️ PM2</h3>
          ${data.pm2 ? `
            <div class="monitoring-items">
              <div class="monitoring-item">
                <span class="monitoring-label">Status</span>
                <span class="badge badge-${getStatusClass(data.pm2.status)}">${getStatusIcon(data.pm2.status)} ${data.pm2.status}</span>
              </div>
              <div class="monitoring-item">
                <span class="monitoring-label">Restarts</span>
                <span class="monitoring-value">${data.pm2.restarts || 0}</span>
              </div>
              <div class="monitoring-item">
                <span class="monitoring-label">CPU</span>
                <span class="monitoring-value">${data.pm2.cpu || 0}%</span>
              </div>
              <div class="monitoring-item">
                <span class="monitoring-label">Mémoire</span>
                <span class="monitoring-value">${data.pm2.memory || '-'}</span>
              </div>
            </div>
          ` : `
            <p class="text-muted">PM2 non détecté. Sera disponible en production.</p>
          `}
        </div>
        
        <!-- Last Syncs -->
        <div class="monitoring-card">
          <h3 class="monitoring-card-title">🔄 Dernières Synchros</h3>
          <div class="monitoring-items">
            <div class="monitoring-item">
              <span class="monitoring-label">Racetime (global)</span>
              <span class="monitoring-value">${this.formatRelativeTime(data.lastSync?.racetime)}</span>
            </div>
            <div class="monitoring-item">
              <span class="monitoring-label">Rando-List</span>
              <span class="monitoring-value">${this.formatRelativeTime(data.lastSync?.randoList)}</span>
            </div>
          </div>
          <div id="github-workflows-status" class="monitoring-items mt-3" style="border-top: 1px solid var(--admin-border); padding-top: 0.75rem;">
            <p class="text-muted" style="font-size: 0.8125rem;">Chargement workflows GitHub...</p>
          </div>
        </div>
      </div>
      
      <!-- Refresh Button -->
      <div class="mt-4">
        <button class="btn btn-outline" onclick="admin.loadMonitoring()">
          🔄 Rafraîchir
        </button>
      </div>
    `;
    
    // Load GitHub workflow statuses
    this.loadGitHubWorkflows();
  },
  
  async loadGitHubWorkflows() {
    const container = document.getElementById('github-workflows-status');
    if (!container) return;
    
    const workflows = [
      { id: 'sync-racetime.yml', name: 'Sync Racetime (5min)', icon: '🏁' },
      { id: 'sync-rando-list.yml', name: 'Sync Rando-List (quotidien)', icon: '📋' },
      { id: 'sync-racetime-game-full.yml', name: 'Sync Game Full (manuel)', icon: '🎮' }
    ];
    
    try {
      const response = await fetch('/api/admin/github/workflows', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) {
        container.innerHTML = '<p class="text-muted" style="font-size: 0.8125rem;">⚠️ API GitHub non configurée</p>';
        return;
      }
      
      const data = await response.json();
      
      if (!data.workflows || data.workflows.length === 0) {
        container.innerHTML = '<p class="text-muted" style="font-size: 0.8125rem;">Aucun workflow trouvé</p>';
        return;
      }
      
      container.innerHTML = `
        <div style="font-size: 0.75rem; color: var(--admin-text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem;">Workflows GitHub Actions</div>
        ${data.workflows.map(wf => {
          const statusClass = wf.conclusion === 'success' ? 'success' : wf.conclusion === 'failure' ? 'danger' : wf.status === 'in_progress' ? 'warning' : 'muted';
          const statusIcon = wf.conclusion === 'success' ? '✓' : wf.conclusion === 'failure' ? '✗' : wf.status === 'in_progress' ? '⏳' : '—';
          const trigger = wf.event === 'schedule' ? '⏰' : wf.event === 'workflow_dispatch' ? '👤' : '🔗';
          return `
            <div class="monitoring-item">
              <span class="monitoring-label">${trigger} ${this.escapeHtml(wf.name)}</span>
              <span>
                <span class="badge badge-${statusClass}">${statusIcon} ${wf.conclusion || wf.status || 'unknown'}</span>
                <span class="monitoring-value" style="margin-left: 0.5rem; font-size: 0.75rem;">${this.formatRelativeTime(wf.updated_at)}</span>
              </span>
            </div>
          `;
        }).join('')}
      `;
      
    } catch (error) {
      console.error('Error loading GitHub workflows:', error);
      container.innerHTML = '<p class="text-muted" style="font-size: 0.8125rem;">❌ Erreur chargement workflows</p>';
    }
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => admin.init());
