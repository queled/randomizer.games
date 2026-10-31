// About page - Load and display statistics

const API_BASE = '';

async function loadStats() {
    const statGames = document.getElementById('stat-games');
    const statTournaments = document.getElementById('stat-tournaments');
    const statRaces = document.getElementById('stat-races');
    const statPlayers = document.getElementById('stat-players');
    
    try {
        // Fetch stats from multiple endpoints
        const responses = await Promise.allSettled([
            fetch(`${API_BASE}/api/games`),
            fetch(`${API_BASE}/api/runs?limit=1`),
            fetch(`${API_BASE}/api/tournaments?limit=1`),
            fetch(`${API_BASE}/api/players/count`)
        ]);
        
        // Handle games (index 0)
        if (responses[0].status === 'fulfilled' && responses[0].value.ok) {
            const gamesData = await responses[0].value.json();
            const games = gamesData.games || gamesData;
            statGames.textContent = Array.isArray(games) ? games.length : (gamesData.total || '0');
        } else {
            statGames.textContent = '0';
        }
        
        // Handle races (index 1)
        if (responses[1].status === 'fulfilled' && responses[1].value.ok) {
            const racesData = await responses[1].value.json();
            // /api/runs returns { races, pagination: { total, page, limit } }
            statRaces.textContent = (racesData.pagination && racesData.pagination.total) || racesData.total || racesData.races?.length || '0';
        } else {
            statRaces.textContent = '0';
        }
        
        // Handle tournaments (index 2)
        if (responses[2].status === 'fulfilled' && responses[2].value.ok) {
            const tournamentsData = await responses[2].value.json();
            // /api/tournaments is paginated: the list holds one page, the total is in pagination
            statTournaments.textContent = (tournamentsData.pagination && tournamentsData.pagination.total) || tournamentsData.total || '0';
        } else {
            statTournaments.textContent = '0';
        }
        
        // Handle players
        if (responses[3].status === 'fulfilled' && responses[3].value.ok) {
            const playersData = await responses[3].value.json();
            statPlayers.textContent = playersData.total || playersData.players?.length || '0';
        } else {
            statPlayers.textContent = '0';
        }

        // Thousands separators in the page language (186913 → 186 913)
        const locale = (window.i18n && window.i18n.getLanguage) ? window.i18n.getLanguage() : undefined;
        [statGames, statRaces, statTournaments, statPlayers].forEach(el => {
            const n = Number(el.textContent);
            if (Number.isFinite(n)) el.textContent = n.toLocaleString(locale);
        });

        // Make stat numbers clickable to the relevant pages
        const makeLink = (el, href) => {
            if (!el) return;
            el.style.cursor = 'pointer';
            el.setAttribute('role', 'link');
            el.addEventListener('click', () => { window.location.href = href; });
        };
        makeLink(statGames, '/games');
        makeLink(statRaces, '/races');
        makeLink(statTournaments, '/tournaments');
        makeLink(statPlayers, '/players');
        
    } catch (error) {
        console.error('Error loading stats:', error);
        
        // Set fallback values
        statGames.textContent = '0';
        statTournaments.textContent = '0';
        statRaces.textContent = '0';
        statPlayers.textContent = '0';
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', loadStats);
