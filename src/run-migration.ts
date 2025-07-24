#!/usr/bin/env node

import { runMigration } from './migrate-cache.js';

console.log('📦 GitHub Metrics Cache Migration Tool');
console.log('=====================================\n');

runMigration().then(() => {
    console.log('\n✅ Migration process completed.');
    process.exit(0);
}).catch((error) => {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
}); 