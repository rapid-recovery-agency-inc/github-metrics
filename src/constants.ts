export const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";
export const DAYS_IN_INTERVAL = 5;

// PERPETUAL CACHE CONFIGURATION
// Perfect for weekly (Friday) and monthly (1st day) reports
// Cache NEVER expires automatically - ideal for historical data that never changes
export const CACHE_TTL_HOURS = 0; // 0 = NEVER EXPIRE (perpetual cache)
export const CACHE_TTL_SECONDS = 0; // 0 = NEVER EXPIRE (perpetual cache)
export const USE_OFFLINE_MODE = process.env.GITHUB_OFFLINE_MODE === 'true';
export const FORCE_REFRESH_MODE = process.env.GITHUB_FORCE_REFRESH === 'true';
export const SKIP_COMMITS = process.env.SKIP_COMMITS === 'true';

// Perpetual cache configuration - optimized for recurring reports
export const CACHE_CONFIG = {
    // Historical data NEVER expires - once merged/closed, it never changes
    HISTORICAL_TTL_HOURS: 0, // PERPETUAL - saves API calls forever
    HISTORICAL_TTL_SECONDS: 0,
    
    // Recent data (last 7 days) - short TTL for potential updates
    RECENT_TTL_HOURS: 6, // 6 hours for very recent data
    RECENT_TTL_SECONDS: 6 * 60 * 60,
    
    // Reviews and events NEVER expire - they're immutable once created
    REVIEWS_TTL_HOURS: 0, // PERPETUAL - reviews never change
    REVIEWS_TTL_SECONDS: 0,
    
    // Today's data - shortest TTL for real-time accuracy
    TODAY_TTL_HOURS: 3, // 3 hours for today's data
    TODAY_TTL_SECONDS: 3 * 60 * 60,
};
export const BLACKLISTED_CODE_USERS = new Set<string>([
    "waqas", "fullstack900", "ghost", "dependabot[bot]", "unknown", "kaikrmen", "metalmagno", "aovallegalan",
    "shedeed1","snyk-bot", "amlingad", "brennenhamilton", "copilot-pull-request-reviewer", "david osorio", "joabcastillo"]);

// Users excluded from all contributor rankings (system accounts and non-evaluatable users)
export const EXCLUDED_FROM_RANKINGS = new Set<string>([
    "yamilachan",
    "edwardzabalaf", 
    "github-actions",
    "github-actions[bot]",
    "esteban199",
    "copilot",
    "copilot-swe-agent",
    "andresviviani1",
    "itensek-margins",
    "tnezic-margins",
    "david osorio",
    "joabcastillo",
    "dantoniazzo-margins"

]);

// Users excluded specifically from closed issues ranking
export const EXCLUDED_FROM_CLOSED_ISSUES = new Set<string>([
    "brennenhamilton",
    "dstjuste", 
    "asadamalik",
    "aovallegalan",
    "metalmagno",
    "ghost",
    "zeeshawn92",
    "amlingad",
    "devin-ai-integration[bot]",
    "gantoreno",
    "shwetatha",
    "djwebexpert",
    "rich-97",
    "devgaurangdevmurari",
    "dhavalpkakadiya",
    "elm4rc0",
    "dfmmalaw",
    "david osorio",
    "joabcastillo"
]);

// Users excluded specifically from dev ranking
export const EXCLUDED_FROM_DEV_RANKING = new Set<string>([
    "itensek-margins",
    "tnezic-margins",
    "david osorio",
    "joabcastillo",
    "dvancel",
    "faiz-gap",
    "dantoniazzo-margins"
]);

// QA team users (quality assurance engineers)
export const QA_USERS = new Set<string>([
    "augustoaf13",
    "juansebasmarin", 
    "nicolas-toledo",
    "altaciosthedev",
    "anjelysleal"
]);

// Expected QA users that should always appear in reports
export const EXPECTED_QA_USERS = [
    "augustoaf13",
    "nicolas-toledo", 
    "anjelysleal",
    "altaciosthedev",
    "juansebasmarin"
];

// Expected Dev users that should always appear in reports
export const EXPECTED_DEV_USERS = [
    "mneto12",
    "jesusrodrz",
    "osorio95",
    "nodejose",
    "franciscomaneiro",
    "samuels2018",
    "alacret",
    "jonmiles",
    "leonellima",
    "manuelp1345",
    "rojolelo",
    "luisleopardi",
    "ragomez33",
    "eliman-c5",
    "jean-yusss",
    "moisesarvelo",
    "shqmv",
    "insighttful",
    "elgeokareem"
];

// Function to determine if a user is QA (case-insensitive)
export const isQAUser = (username: string): boolean => {
    return QA_USERS.has(username.toLowerCase());
};

export const AUTHOR_ALIAS_MAP = new Map<string, string>([
    ["yeferson hidalgo", "memimint"],
    ["jonathan miles", "jonmiles"],
    ["leonel lima", "leonellima"],
    ["raul gomez", "ragomez33"],
    ["ronny legones", "rojolelo"]
]);
