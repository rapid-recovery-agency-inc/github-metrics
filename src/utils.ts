// Helper function to break down date range into intervals to avoid hitting the 1000 search limit
import {DateInterval} from "./types";

const DAYS_IN_INTERVAL = 5;

export function getDateIntervals(
    startDate: Date,
    endDate: Date,
    intervalInDays = DAYS_IN_INTERVAL
): DateInterval[] {
    const intervals: { since: string; until: string }[] = [];
    let currentStartDate = new Date(startDate);
    while (currentStartDate < endDate) {
        const currentEndDate = new Date(currentStartDate);
        currentEndDate.setDate(currentEndDate.getDate() + intervalInDays);
        intervals.push({
            since: currentStartDate.toISOString(),
            until: (currentEndDate > endDate
                    ? endDate
                    : currentEndDate
            ).toISOString(),
        });
        currentStartDate = new Date(currentEndDate);
    }
    return intervals;
}
