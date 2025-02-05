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
