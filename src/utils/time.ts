export function formatJstFromEpoch(epochSeconds: number): string {
	const ms = epochSeconds * 1000;
	// Add 9 hours to UTC then format as YYYY/MM/DD HH:MM JST
	const d = new Date(ms + 9 * 60 * 60 * 1000);
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	const hh = String(d.getUTCHours()).padStart(2, '0');
	const mm = String(d.getUTCMinutes()).padStart(2, '0');
	return `${y}/${m}/${day} ${hh}:${mm} JST`;
}

