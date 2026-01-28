const axios = require('axios');

/**
 * Service pour l'API speedrun.com
 * Documentation: https://github.com/speedruncomorg/api/tree/master/version1
 */
class SpeedrunAPI {
  constructor() {
    this.baseURL = 'https://www.speedrun.com/api/v1';
    this.rateLimit = 100; // ms entre les requêtes
    this.lastRequest = 0;
  }

  async _throttle() {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.rateLimit) {
      await new Promise(r => setTimeout(r, this.rateLimit - elapsed));
    }
    this.lastRequest = Date.now();
  }

  async _get(endpoint, params = {}) {
    await this._throttle();
    try {
      const response = await axios.get(`${this.baseURL}${endpoint}`, {
        params,
        timeout: 10000,
        headers: {
          'User-Agent': 'RandomizerWebsite/1.0'
        }
      });
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      console.error(`Speedrun API error ${endpoint}:`, error.message);
      throw error;
    }
  }

  /**
   * Recherche un jeu par nom
   * @param {string} name - Nom du jeu à rechercher
   * @returns {Promise<Array>} Liste des jeux correspondants
   */
  async searchGame(name) {
    const data = await this._get('/games', { name, max: 20 });
    return data?.data || [];
  }

  /**
   * Récupère un jeu par son ID speedrun.com
   * @param {string} gameId - ID du jeu sur speedrun.com
   * @returns {Promise<Object|null>} Données du jeu
   */
  async getGameById(gameId) {
    const data = await this._get(`/games/${gameId}`, {
      embed: 'platforms,genres,developers,publishers'
    });
    return data?.data || null;
  }

  /**
   * Récupère les catégories d'un jeu
   * @param {string} gameId - ID du jeu sur speedrun.com
   * @returns {Promise<Array>} Liste des catégories
   */
  async getGameCategories(gameId) {
    const data = await this._get(`/games/${gameId}/categories`);
    return data?.data || [];
  }

  /**
   * Formate les données d'un jeu speedrun.com vers notre schéma
   * @param {Object} srcGame - Jeu de l'API speedrun.com
   * @returns {Object} Données formatées
   */
  formatGame(srcGame) {
    if (!srcGame) return null;

    // Extraire les plateformes
    const platforms = [];
    if (srcGame.platforms?.data) {
      for (const p of srcGame.platforms.data) {
        platforms.push(this._mapPlatformName(p.name));
      }
    }

    // Extraire la date de sortie
    let releaseDate = null;
    if (srcGame.released) {
      releaseDate = new Date(srcGame.released, 0, 1);
    } else if (srcGame['release-date']) {
      releaseDate = new Date(srcGame['release-date']);
    }

    return {
      id: srcGame.id,
      name: srcGame.names?.international || srcGame.names?.japanese,
      abbreviation: srcGame.abbreviation,
      weblink: srcGame.weblink,
      releaseDate,
      platforms,
      assets: {
        logo: srcGame.assets?.logo?.uri,
        coverSmall: srcGame.assets?.['cover-small']?.uri,
        coverMedium: srcGame.assets?.['cover-medium']?.uri,
        coverLarge: srcGame.assets?.['cover-large']?.uri,
        icon: srcGame.assets?.icon?.uri,
        background: srcGame.assets?.background?.uri
      },
      developers: srcGame.developers?.data?.map(d => d.name) || [],
      publishers: srcGame.publishers?.data?.map(p => p.name) || []
    };
  }

  /**
   * Convertit le nom de plateforme speedrun.com vers notre format
   */
  _mapPlatformName(name) {
    const mapping = {
      'Super Nintendo': 'SNES',
      'Nintendo Entertainment System': 'NES',
      'Nintendo 64': 'N64',
      'Nintendo GameCube': 'GCN',
      'Nintendo Switch': 'Switch',
      'Wii U': 'WiiU',
      'Wii': 'Wii',
      'Game Boy Advance': 'GBA',
      'Game Boy': 'GB',
      'Nintendo DS': 'DS',
      'Nintendo 3DS': '3DS',
      'PlayStation': 'PS1',
      'PlayStation 2': 'PS2',
      'PlayStation 3': 'PS3',
      'PlayStation 4': 'PS4',
      'PlayStation 5': 'PS5',
      'PlayStation Portable': 'PSP',
      'PlayStation Vita': 'PSVita',
      'Xbox': 'Xbox',
      'Xbox 360': 'Xbox360',
      'Xbox One': 'XboxOne',
      'Xbox Series X/S': 'XboxSeriesX',
      'PC': 'PC',
      'Sega Genesis': 'Genesis',
      'Sega Saturn': 'Saturn',
      'Sega Dreamcast': 'Dreamcast'
    };
    return mapping[name] || name;
  }

  /**
   * Trouve le meilleur match pour un jeu donné
   * @param {string} name - Nom du jeu
   * @param {string} abbreviation - Abréviation optionnelle
   * @returns {Promise<{game: Object, confidence: string}>}
   */
  async findBestMatch(name, abbreviation = null) {
    const results = await this.searchGame(name);
    
    if (!results.length) {
      return { game: null, confidence: null };
    }

    // Match exact sur l'abréviation
    if (abbreviation) {
      const exactAbbr = results.find(g => 
        g.abbreviation?.toLowerCase() === abbreviation.toLowerCase()
      );
      if (exactAbbr) {
        return { game: this.formatGame(exactAbbr), confidence: 'auto' };
      }
    }

    // Match exact sur le nom
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const exactName = results.find(g => {
      const gName = (g.names?.international || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return gName === normalizedName;
    });
    if (exactName) {
      return { game: this.formatGame(exactName), confidence: 'auto' };
    }

    // Premier résultat avec confiance basse
    return { game: this.formatGame(results[0]), confidence: 'low' };
  }
}

module.exports = new SpeedrunAPI();
