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
      this.debounce(() => this.loadGames(), 300)
    );
    
    document.getElementById('games-filter-enabled').addEventListener('change', 
      () => this.loadGames()
    );
    
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
      
      // Alerts
      const alertsEl = document.getElementById('dashboard-alerts');
      let alertsHtml = '';
      
      if (stats.games.needingResources > 0) {
        alertsHtml += `
          <div class="alert alert-warning">
            <span class="alert-icon">⚠️</span>
            <span class="alert-text">${stats.games.needingResources} jeu(x) sans site officiel configuré</span>
            <button class="btn btn-sm btn-outline" onclick="admin.navigateTo('resources')">Configurer</button>
          </div>
        `;
      }
      
      if (stats.games.needingOfficialSite > 0) {
        alertsHtml += `
          <div class="alert alert-info">
            <span class="alert-icon">ℹ️</span>
            <span class="alert-text">${stats.games.needingOfficialSite} jeu(x) avec plusieurs sites (site officiel à définir)</span>
            <button class="btn btn-sm btn-outline" onclick="admin.navigateTo('resources')">Voir</button>
          </div>
        `;
      }
      
      alertsEl.innerHTML = alertsHtml;
      
    } catch (error) {
      console.error('Error loading dashboard:', error);
      this.showToast('Erreur lors du chargement', 'error');
    }
  },
  
  // ==================== GAMES ====================
  
  async loadGames(page = 1) {
    try {
      const search = document.getElementById('games-search').value;
      const enabled = document.getElementById('games-filter-enabled').value;
      
      const params = new URLSearchParams({ page, limit: 20 });
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
          </td>
        </tr>
      `;
    }).join('');
  },
  
  renderPagination(pagination, type) {
    const container = document.getElementById(`${type}-pagination`);
    
    if (pagination.pages <= 1) {
      container.innerHTML = '';
      return;
    }
    
    let html = '<div class="pagination-buttons">';
    
    if (pagination.page > 1) {
      html += `<button class="btn btn-sm btn-outline" onclick="admin.load${this.capitalize(type)}(${pagination.page - 1})">←</button>`;
    }
    
    html += `<span class="pagination-info">Page ${pagination.page} / ${pagination.pages}</span>`;
    
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
      document.getElementById('game-id').disabled = true;
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
      this.loadGames();
      
    } catch (error) {
      console.error('Error saving game:', error);
      this.showToast(error.message, 'error');
    }
  },
  
  viewGameResources(gameId) {
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
      
      const select = document.getElementById('resources-game-select');
      const currentValue = select.value;
      
      select.innerHTML = '<option value="">Sélectionner un jeu...</option>' +
        data.games
          .filter(g => g.enabled !== false)
          .map(g => `<option value="${g.id}">${g.name} (${g.id})</option>`)
          .join('');
      
      if (currentValue) {
        select.value = currentValue;
      }
      
    } catch (error) {
      console.error('Error loading games for select:', error);
    }
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
  
  renderResources(data) {
    const resources = data.resources || {};
    
    // Official site
    const officialDisplay = document.getElementById('official-site-display');
    if (resources.officialSite?.url) {
      officialDisplay.innerHTML = `
        <div class="resource-item resource-item-primary">
          <span class="resource-icon">${resources.officialSite.isArchipelago ? '🏝️' : '🌐'}</span>
          <a href="${resources.officialSite.url}" target="_blank" class="resource-link">
            ${this.escapeHtml(resources.officialSite.name || 'Site officiel')}
          </a>
          <button class="btn btn-sm btn-ghost btn-danger" onclick="admin.removeOfficialSite()">×</button>
        </div>
      `;
    } else {
      officialDisplay.innerHTML = '<p class="text-muted">Aucun site officiel défini</p>';
    }
    
    // Pre-fill form if legacy website exists
    if (!resources.officialSite?.url && data.legacyWebsite) {
      document.getElementById('official-site-url').value = data.legacyWebsite;
    }
    
    // Sites from rando-list
    const sitesList = document.getElementById('sites-list');
    if (resources.sites?.length > 0) {
      sitesList.innerHTML = resources.sites.map((site, i) => `
        <div class="resource-item ${site.isObsolete ? 'resource-item-obsolete' : ''}">
          <span class="resource-icon">${site.isArchipelago ? '🏝️' : '🔗'}</span>
          <a href="${site.url}" target="_blank" class="resource-link">
            ${this.escapeHtml(site.name || site.url)}
          </a>
          <span class="resource-source">${site.source}</span>
          ${!resources.officialSite?.url && !site.isObsolete ? 
            `<button class="btn btn-sm btn-ghost" onclick="admin.setAsOfficialSite(${i})" title="Définir comme site officiel">⭐</button>` : 
            ''}
        </div>
      `).join('');
    } else {
      sitesList.innerHTML = '<p class="text-muted">Aucun site depuis rando-list</p>';
    }
    
    // Trackers
    const trackersList = document.getElementById('trackers-list');
    if (resources.trackers?.length > 0) {
      trackersList.innerHTML = resources.trackers.map((tracker, i) => `
        <div class="resource-item">
          <span class="resource-icon">📍</span>
          <div class="resource-details">
            <a href="${tracker.url}" target="_blank" class="resource-link">${this.escapeHtml(tracker.name)}</a>
            ${tracker.description ? `<span class="resource-desc">${this.escapeHtml(tracker.description)}</span>` : ''}
          </div>
          <button class="btn btn-sm btn-ghost btn-danger" onclick="admin.removeTracker(${i})">×</button>
        </div>
      `).join('');
    } else {
      trackersList.innerHTML = '<p class="text-muted">Aucun tracker</p>';
    }
    
    // Guides
    const guidesList = document.getElementById('guides-list');
    if (resources.guides?.length > 0) {
      const typeIcons = { guide: '📖', tutorial: '🎓', wiki: '📝', video: '🎬' };
      guidesList.innerHTML = resources.guides.map((guide, i) => `
        <div class="resource-item">
          <span class="resource-icon">${typeIcons[guide.type] || '📖'}</span>
          <div class="resource-details">
            <a href="${guide.url}" target="_blank" class="resource-link">${this.escapeHtml(guide.name)}</a>
            ${guide.description ? `<span class="resource-desc">${this.escapeHtml(guide.description)}</span>` : ''}
          </div>
          <span class="resource-type">${guide.type}</span>
          <button class="btn btn-sm btn-ghost btn-danger" onclick="admin.removeGuide(${i})">×</button>
        </div>
      `).join('');
    } else {
      guidesList.innerHTML = '<p class="text-muted">Aucun guide</p>';
    }
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
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => admin.init());
