export const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";
export const DAYS_IN_INTERVAL = 5;
export const BLACKLISTED_CODE_USERS = new Set<string>([
    "waqas", "fullstack900", "ghost", "dependabot[bot]", "unknown", "kaikrmen", "metalmagno", "aovallegalan",
    "shedeed1","snyk-bot", "amlingad", "brennenhamilton", "copilot-pull-request-reviewer"]);

// Users excluded from all contributor rankings (system accounts and non-evaluatable users)
export const EXCLUDED_FROM_RANKINGS = new Set<string>([
    "yamilachan",
    "edwardzabalaf", 
    "github-actions",
    "github-actions[bot]",
    "esteban199",
    "copilot",
    "copilot-swe-agent"
]);

// QA team users (quality assurance engineers)
export const QA_USERS = new Set<string>([
    "augustoaf13",
    "juansebasmarin", 
    "nicolas-toledo",
    "altaciosthedev",
    "anjelysleal"
]);

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
