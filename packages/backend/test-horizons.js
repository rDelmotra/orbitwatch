import { fetchHorizonsVectors } from './src/services/horizons.js';
const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
const stop = new Date(Date.now() + 46 * 60 * 60 * 1000);
console.log('Fetching...');
try {
    const data = await fetchHorizonsVectors('-1024', start, stop, 10);
    console.log(`Success! Points: ${data.length}`);
}
catch (e) {
    console.error('Failed to fetch:', e);
}
