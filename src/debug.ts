import fs from 'fs';
import path from 'path';


let debugCounter = 0;
export const debugToFile = (data: string): void => {
    const currentDebugCounter = debugCounter++;
    const fileName = `debug-${debugCounter}.json`;
    const filePath = path.join('disk-cache', fileName)
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '{}');
    }
    fs.writeFileSync(filePath, data);
}
