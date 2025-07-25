import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

// Ensure cache directory exists
const CACHE_DIR = 'disk-cache';
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const DB_PATH = path.join(CACHE_DIR, 'github-metrics.db');

class SQLiteCache {
    private db: sqlite3.Database;
    private readonly tableName: string;

    constructor(tableName: string) {
        this.tableName = tableName;
        this.db = new sqlite3.Database(DB_PATH);
        
        // Serialize to ensure operations happen in order
        this.db.serialize(() => {
            // Enable WAL mode for better performance
            this.db.run('PRAGMA journal_mode = WAL');
            this.db.run('PRAGMA synchronous = NORMAL');
            this.db.run('PRAGMA cache_size = 1000');
            this.db.run('PRAGMA temp_store = MEMORY');
            
            this.initializeTable();
        });
    }

    // Initialize and wait for table creation
    async initialize(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                const createTableSQL = `
                    CREATE TABLE IF NOT EXISTS ${this.tableName} (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        expires_at DATETIME DEFAULT NULL
                    )
                `;
                
                this.db.run(createTableSQL, (err) => {
                    if (err) {
                        console.error(`Error creating table ${this.tableName}:`, err);
                        reject(err);
                        return;
                    }
                });
                
                // Create index on expires_at for efficient cleanup
                const createIndexSQL = `
                    CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expires 
                    ON ${this.tableName}(expires_at)
                `;
                
                this.db.run(createIndexSQL, (indexErr) => {
                    if (indexErr) {
                        console.error(`Error creating index for ${this.tableName}:`, indexErr);
                        reject(indexErr);
                    } else {
                        console.log(`✅ Table ${this.tableName} initialized successfully`);
                        resolve();
                    }
                });
            });
        });
    }

    private initializeTable(): void {
        // Synchronous fallback - just for compatibility
        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME DEFAULT NULL
            )
        `;
        
        this.db.run(createTableSQL);
        
        // Create index on expires_at for efficient cleanup
        const createIndexSQL = `
            CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expires 
            ON ${this.tableName}(expires_at)
        `;
        
        this.db.run(createIndexSQL);
    }

    get<T>(key: string): Promise<T | undefined> {
        return new Promise((resolve, reject) => {
            const selectSQL = `
                SELECT value FROM ${this.tableName} 
                WHERE key = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
            `;
            
            this.db.get(selectSQL, [key], (err, row: any) => {
                if (err) {
                    console.error(`Error getting key ${key} from ${this.tableName}:`, err);
                    reject(err);
                    return;
                }
                
                if (row) {
                    try {
                        const value = JSON.parse(row.value);
                        resolve(value);
                    } catch (parseErr) {
                        console.error(`Error parsing JSON for key ${key}:`, parseErr);
                        resolve(undefined);
                    }
                } else {
                    resolve(undefined);
                }
            });
        });
    }

    set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const serializedValue = JSON.stringify(value);
            const expiresAt = ttlSeconds 
                ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
                : null;
            
            const insertSQL = `
                INSERT OR REPLACE INTO ${this.tableName} (key, value, created_at, expires_at)
                VALUES (?, ?, datetime('now'), ?)
            `;
            
            this.db.run(insertSQL, [key, serializedValue, expiresAt], (err) => {
                if (err) {
                    console.error(`Error setting key ${key} in ${this.tableName}:`, err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    delete(key: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const deleteSQL = `DELETE FROM ${this.tableName} WHERE key = ?`;
            
            this.db.run(deleteSQL, [key], (err) => {
                if (err) {
                    console.error(`Error deleting key ${key} from ${this.tableName}:`, err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    clear(): Promise<void> {
        return new Promise((resolve, reject) => {
            const deleteSQL = `DELETE FROM ${this.tableName}`;
            
            this.db.run(deleteSQL, (err) => {
                if (err) {
                    console.error(`Error clearing table ${this.tableName}:`, err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    // Clean up expired entries
    cleanup(): Promise<void> {
        return new Promise((resolve, reject) => {
            const deleteSQL = `
                DELETE FROM ${this.tableName} 
                WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')
            `;
            
            this.db.run(deleteSQL, (err) => {
                if (err) {
                    console.error(`Error cleaning up ${this.tableName}:`, err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    close(): Promise<void> {
        return new Promise((resolve) => {
            this.db.close((err) => {
                if (err) {
                    console.error(`Error closing database for ${this.tableName}:`, err);
                }
                resolve();
            });
        });
    }
}

// Legacy compatibility wrapper for synchronous interface
class CompatibilityCache {
    private sqliteCache: SQLiteCache;
    private memoryCache: Map<string, any> = new Map();
    private loadPromise: Promise<void>;

    constructor(tableName: string) {
        this.sqliteCache = new SQLiteCache(tableName);
        this.loadPromise = this.loadFromDatabase();
    }

    private async loadFromDatabase(): Promise<void> {
        // This is a compatibility layer - in production we'd want to avoid loading everything into memory
        // but for now we maintain the synchronous interface
    }

    get<T>(key: string): T | undefined {
        // Return from memory cache for synchronous access
        return this.memoryCache.get(key);
    }

    set<T>(key: string, value: T): void {
        // Update memory cache immediately for synchronous access
        this.memoryCache.set(key, value);
        
        // Asynchronously update SQLite
        this.sqliteCache.set(key, value).catch(err => {
            console.error(`Error updating SQLite cache for key ${key}:`, err);
        });
    }

    async getAsync<T>(key: string): Promise<T | undefined> {
        return this.sqliteCache.get<T>(key);
    }

    async setAsync<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
        this.memoryCache.set(key, value);
        return this.sqliteCache.set(key, value, ttlSeconds);
    }

    async preloadKey(key: string): Promise<void> {
        const value = await this.sqliteCache.get(key);
        if (value !== undefined) {
            this.memoryCache.set(key, value);
        }
    }

    async cleanup(): Promise<void> {
        return this.sqliteCache.cleanup();
    }

    async close(): Promise<void> {
        return this.sqliteCache.close();
    }
}

// Export cache instances
export const COMMITS_CACHE = new CompatibilityCache('commits_cache');
export const PRS_CACHE = new CompatibilityCache('prs_cache');
export const PRS_REVIEW_CACHE = new CompatibilityCache('prs_review_cache');
export const ISSUES_CACHE = new CompatibilityCache('issues_cache');
export const ISSUE_EVENTS_CACHE = new CompatibilityCache('issue_events_cache');

// Export the SQLiteCache class for direct use when async is preferred
export { SQLiteCache };

// Cleanup function to be called periodically
export async function cleanupAllCaches(): Promise<void> {
    const caches = [COMMITS_CACHE, PRS_CACHE, PRS_REVIEW_CACHE, ISSUES_CACHE, ISSUE_EVENTS_CACHE];
    
    for (const cache of caches) {
        try {
            await cache.cleanup();
        } catch (err) {
            console.error('Error cleaning up cache:', err);
        }
    }
}

// Close all caches gracefully
export async function closeAllCaches(): Promise<void> {
    const caches = [COMMITS_CACHE, PRS_CACHE, PRS_REVIEW_CACHE, ISSUES_CACHE, ISSUE_EVENTS_CACHE];
    
    for (const cache of caches) {
        try {
            await cache.close();
        } catch (err) {
            console.error('Error closing cache:', err);
        }
    }
}
