import fs from 'fs';
import path from 'path';
import { SQLiteCache } from './cache.js';

interface MigrationResult {
    tableName: string;
    sourceFile: string;
    keysTransferred: number;
    errors: number;
    success: boolean;
}

async function migrateJSONToSQLite(): Promise<MigrationResult[]> {
    const migrations = [
        { tableName: 'commits_cache', fileName: 'commits.json' },
        { tableName: 'prs_cache', fileName: 'prs.json' },
        { tableName: 'prs_review_cache', fileName: 'prs-reviews.json' },
        { tableName: 'issues_cache', fileName: 'issues.json' },
        { tableName: 'issue_events_cache', fileName: 'issue-events.json' }
    ];

    const results: MigrationResult[] = [];

    for (const migration of migrations) {
        const result = await migrateSingleFile(migration.tableName, migration.fileName);
        results.push(result);
        console.log(`Migration ${migration.tableName}: ${result.success ? 'SUCCESS' : 'FAILED'} - ${result.keysTransferred} keys transferred, ${result.errors} errors`);
    }

    return results;
}

async function migrateSingleFile(tableName: string, fileName: string): Promise<MigrationResult> {
    const result: MigrationResult = {
        tableName,
        sourceFile: fileName,
        keysTransferred: 0,
        errors: 0,
        success: false
    };

    const filePath = path.join('disk-cache', fileName);
    
    try {
        // Check if source file exists
        if (!fs.existsSync(filePath)) {
            console.log(`Source file ${filePath} does not exist, skipping migration.`);
            result.success = true;
            return result;
        }

        // Read and parse JSON file
        const fileContents = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(fileContents);

        if (!data || typeof data !== 'object') {
            console.log(`No data found in ${fileName}, skipping migration.`);
            result.success = true;
            return result;
        }

        // Initialize SQLite cache
        const cache = new SQLiteCache(tableName);
        await cache.initialize();

        // Migrate each key-value pair
        const keys = Object.keys(data);
        console.log(`Migrating ${keys.length} keys from ${fileName} to ${tableName}...`);

        for (const key of keys) {
            try {
                await cache.set(key, data[key]);
                result.keysTransferred++;
                
                // Log progress for large files
                if (result.keysTransferred % 100 === 0) {
                    console.log(`  Progress: ${result.keysTransferred}/${keys.length} keys migrated`);
                }
            } catch (error) {
                console.error(`Error migrating key ${key}:`, error);
                result.errors++;
            }
        }

        // Close the cache connection
        await cache.close();

        result.success = result.errors === 0;
        console.log(`Completed migration of ${fileName}: ${result.keysTransferred} keys transferred`);

        // Optionally backup the original file
        if (result.success && result.keysTransferred > 0) {
            const backupPath = filePath + '.backup';
            fs.copyFileSync(filePath, backupPath);
            console.log(`Original file backed up to ${backupPath}`);
        }

    } catch (error) {
        console.error(`Error during migration of ${fileName}:`, error);
        result.errors++;
    }

    return result;
}

// Function to verify migration by comparing a sample of keys
async function verifyMigration(tableName: string, fileName: string, sampleSize: number = 10): Promise<boolean> {
    const filePath = path.join('disk-cache', fileName);
    
    if (!fs.existsSync(filePath)) {
        return true; // No source file to verify against
    }

    try {
        const fileContents = fs.readFileSync(filePath, 'utf8');
        const originalData = JSON.parse(fileContents);
        const keys = Object.keys(originalData);
        
        if (keys.length === 0) {
            return true; // No data to verify
        }

        const cache = new SQLiteCache(tableName);
        await cache.initialize();
        const sampleKeys = keys.slice(0, Math.min(sampleSize, keys.length));
        
        let matches = 0;
        for (const key of sampleKeys) {
            const originalValue = originalData[key];
            const cachedValue = await cache.get(key);
            
            if (JSON.stringify(originalValue) === JSON.stringify(cachedValue)) {
                matches++;
            } else {
                console.error(`Verification failed for key ${key}: values don't match`);
            }
        }
        
        await cache.close();
        
        const successRate = matches / sampleKeys.length;
        console.log(`Verification for ${tableName}: ${matches}/${sampleKeys.length} keys match (${(successRate * 100).toFixed(2)}%)`);
        
        return successRate === 1.0;
        
    } catch (error) {
        console.error(`Error during verification of ${tableName}:`, error);
        return false;
    }
}

// Main migration function
export async function runMigration(): Promise<void> {
    console.log('🚀 Starting cache migration from JSON to SQLite...');
    
    const results = await migrateJSONToSQLite();
    
    console.log('\n📊 Migration Summary:');
    let totalKeys = 0;
    let totalErrors = 0;
    let successfulMigrations = 0;
    
    for (const result of results) {
        totalKeys += result.keysTransferred;
        totalErrors += result.errors;
        if (result.success) successfulMigrations++;
        
        console.log(`  ${result.tableName}: ${result.keysTransferred} keys, ${result.errors} errors`);
    }
    
    console.log(`\nTotal: ${totalKeys} keys migrated, ${totalErrors} errors`);
    console.log(`Successful migrations: ${successfulMigrations}/${results.length}`);
    
    // Run verification
    console.log('\n🔍 Verifying migration...');
    const verifications = await Promise.all(
        results.map(r => verifyMigration(r.tableName, r.sourceFile))
    );
    
    const allVerified = verifications.every(v => v);
    console.log(`Verification: ${allVerified ? '✅ PASSED' : '❌ FAILED'}`);
    
    if (allVerified && totalErrors === 0) {
        console.log('\n🎉 Migration completed successfully!');
        console.log('You can now safely delete the old JSON cache files if desired.');
    } else {
        console.log('\n⚠️  Migration completed with issues. Please review the errors above.');
    }
}

// CLI interface - ES modules compatible
if (import.meta.url === `file://${process.argv[1]}`) {
    runMigration().catch(console.error);
} 