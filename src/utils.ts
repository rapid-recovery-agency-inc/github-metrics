// Helper function to break down date range into intervals to avoid hitting the 1000 search limit
import {DateInterval} from "./types";


export function getDateIntervals(
    startDate: Date,
    endDate: Date,
    intervalInDays: number,
): DateInterval[] {
    const intervals: DateInterval[] = [];
    let currentStartDate = new Date(startDate);
    while (currentStartDate < endDate) {
        const currentEndDate = new Date(currentStartDate);
        currentEndDate.setDate(currentEndDate.getDate() + intervalInDays);
        intervals.push({
            since: roundDateToNearestHour(currentStartDate).toISOString(),
            until: roundDateToNearestHour(currentEndDate > endDate
                ? endDate
                : currentEndDate
            ).toISOString(),
        });
        currentStartDate = new Date(currentEndDate);
    }
    return intervals;
}


export function roundDateToNearestHour(date: Date) {
    const minutes = date.getMinutes();
    if (minutes >= 30) {
        // If 30 or more minutes, round up to the next hour
        date.setHours(date.getHours() + 1);
    }
    // Set minutes, seconds, and milliseconds to zero
    date.setMinutes(0, 0, 0);
    return date;
}


// Sleep function in seconds
export function sleepInSeconds(seconds: number): Promise<void> {
    return sleep(seconds * 1000);
}

// Sleep function in milliseconds
export async function sleep(milliseconds: number): Promise<void> {
    console.log(`sleep:Sleeping for ${milliseconds / 1000} seconds`);
    if (milliseconds < 60000) {
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
        return Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 60000));
    return sleep(milliseconds - 60000);
}


// Helper function to handle rate limits and retry after the reset time
export async function handleRateLimit(response: any) {
    if (response.headers["x-ratelimit-remaining"] === "0") {
        const resetTimestamp =
            parseInt(response.headers["x-ratelimit-reset"], 10) * 1000; // Convert to milliseconds
        const resetTime = new Date(resetTimestamp);
        const currentTime = new Date();

        const waitTime = resetTime.getTime() - currentTime.getTime();

        // Wait until the rate limit resets
        await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
}

// Retry logic for network failures
export async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000,
    operationName: string = "operation"
): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            lastError = error;
            
            // Check if it's a network error we should retry
            const isRetryableError = 
                error.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
                error.code === 'ECONNRESET' ||
                error.code === 'ETIMEDOUT' ||
                error.type === 'system' ||
                (error.status && [502, 503, 504, 429].includes(error.status));
            
            if (!isRetryableError || attempt === maxRetries) {
                console.error(`❌ ${operationName} failed after ${attempt} attempts:`, error.message);
                throw error;
            }
            
            const delay = baseDelay * Math.pow(2, attempt - 1);
            console.log(`⚠️  ${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
            console.log(`   Error: ${error.message}`);
            
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError!;
}
