import fs from 'fs';
import path from 'path';

class DiskCache {
    private readonly cache: Record<string, any>;
    private readonly filename: string;

    constructor(filename: string) {
        this.filename = filename;
        // Load cache from disk
        // Check if file exists, else create it:
        if(!fs.existsSync(filename)) {
            fs.writeFileSync(filename, '{}');
        }
        const fileContents = fs.readFileSync(filename, 'utf8');
        this.cache = JSON.parse(fileContents);
    }

    get<T>(key: string): T | undefined {
        return this.cache[key];
    }

    set<T>(key: string, value: T): void {
        this.cache[key] = value;
        // write to disk
        fs.writeFileSync(this.filename, JSON.stringify(this.cache));
    }
}


export const COMMITS_CACHE: DiskCache = new DiskCache(path.join('disk-cache', 'commits.json'));
export const PRS_CACHE: DiskCache = new DiskCache(path.join('disk-cache', 'prs.json'));
export const PRS_REVIEW_CACHE: DiskCache = new DiskCache(path.join('disk-cache', 'prs-reviews.json'));
export const ISSUES_CACHE: DiskCache = new DiskCache(path.join('disk-cache', 'issues.json'));
export const ISSUE_EVENTS_CACHE: DiskCache = new DiskCache(path.join('disk-cache', 'issue-events.json'));
