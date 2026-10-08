/* Names for an index and for the firms it ranks. */

export function indexTitle(indexSlug) {
	// bristol-estate-agents -> "Bristol Estate Agent"
	const words = indexSlug.split('-');
	const city = words[0][0].toUpperCase() + words[0].slice(1);
	const sector = words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').replace(/s$/, '');
	return `${city} ${sector}`;
}

/* What the page calls the firms it ranks. The title ("Gloucestershire Double
   Glazing") is a name, not a noun: lowercasing it and adding an s produced
   "99 gloucestershire double glazings" and "52 cheltenham constructions" on
   every index page. The sector config carries the real nouns and the index
   config the place, so: "99 double glazing companies in Gloucestershire",
   "which double glazing company in Gloucestershire". Without config the old
   derivation stands, with "firms" rather than a bare s. */
export function cohortNouns(indexSlug, indexCfg = null, sectorCfg = null) {
	const place = indexCfg?.town ?? null;
	if (sectorCfg?.label && sectorCfg?.singular && place) {
		return { plural: `${sectorCfg.label} in ${place}`, singular: `${sectorCfg.singular} in ${place}` };
	}
	const base = indexTitle(indexSlug).toLowerCase();
	return { plural: `${base} firms`, singular: `${base} firm` };
}
