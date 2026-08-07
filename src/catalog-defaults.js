// ─── Canonical catalog — the "real, current prices" from the pricing sheet ──
// Extracted VERBATIM from photo-upload-mockupV2.html so the backend and the
// front end agree to the penny. Per plan §7 these are seeded into the DB and
// then edited through the admin page — never hardcoded in the client again.

export const PAPERS = [
  { id: 'cp-glossy', label: 'Chromogenic · Fuji Crystal Archive Glossy', fam: 'cprint' },
  { id: 'cp-matte',  label: 'Chromogenic · Fuji Crystal Archive Matte',  fam: 'cprint' },
  { id: 'pg-cotton', label: 'Archival Pigment · Smooth Cotton',          fam: 'pigment' },
  { id: 'pg-baryta', label: 'Archival Pigment · Baryta Satin (Recommended)', fam: 'pigment' },
];

export const PAPER_DESC = {
  'cp-glossy': 'A true photographic print on Fuji Crystal Archive paper. It has rich, saturated color, deep blacks, and a bright glossy sheen. It holds its color for decades.',
  'cp-matte':  'A true photographic print on Fuji Crystal Archive paper with a glare-free matte surface. It keeps its color for decades.',
  'pg-cotton': 'Pigment inks on 100% cotton rag paper. A soft, painterly matte surface that fine-art photographers favor. It holds its detail and color for generations.',
  'pg-baryta': 'Pigment inks on a baryta fine-art paper. It has the depth and subtle sheen of a classic darkroom print. It holds rich color for generations. Pochron Studios recommends it for most images.',
};

export const SIZES = ['4×4','4×6','5×5','5×7','8×8','8×10','8×12','10×10','11×14','12×12','12×18','16×16','16×20','20×20','20×24','20×30','24×24','24×36','30×30','30×40'];

export const PRICES = {
  cprint:  {'4×4':0.79,'4×6':0.79,'5×5':1.79,'5×7':1.79,'8×8':4.95,'8×10':4.95,'8×12':5.95,'10×10':6.95,'11×14':9.95,'12×12':9.95,'12×18':13.95,'16×16':19.95,'16×20':24.95,'20×20':34.95,'20×24':39.95,'20×30':54.95,'24×24':54.95,'24×36':79.95,'30×30':89.95,'30×40':119.95},
  pigment: {'4×4':2.95,'4×6':2.95,'5×5':4.95,'5×7':4.95,'8×8':7.95,'8×10':7.95,'8×12':8.95,'10×10':9.95,'11×14':14.95,'12×12':14.95,'12×18':19.95,'16×16':29.95,'16×20':34.95,'20×20':49.95,'20×24':54.95,'20×30':74.95,'24×24':79.95,'24×36':109.95,'30×30':129.95,'30×40':159.95},
};

// Border is free and modelled as a fit choice, not a decorative width (§7).
export const BORDERS = {
  none:   { label: 'No border (fills the print)',        add: 0 },
  border: { label: 'White border (fits the whole image)', add: 0 },
};

export const SHIP_METHODS = [
  { id: 'standard',  label: 'Standard (5–7 business days)',  cost: 12 },
  { id: 'expedited', label: 'Expedited (2–3 business days)', cost: 28 },
];

// Shipping by destination region. Domestic is charged as-is; international is a
// ceiling ("up to $X", captured at the real cost). States/countries map to these
// region keys in code; these rows are just the editable prices. expedited=null
// means the region offers a single (standard) speed.
export const SHIP_ZONES = [
  { key: 'ne',   label: 'Northeast & Mid-Atlantic',     kind: 'domestic', standard: 15, expedited: 26, sort: 0 },
  { key: 'se',   label: 'Southeast & Great Lakes',      kind: 'domestic', standard: 21, expedited: 34, sort: 1 },
  { key: 'pm',   label: 'Plains, S-Central & Mountain', kind: 'domestic', standard: 32, expedited: 48, sort: 2 },
  { key: 'wc',   label: 'West Coast',                   kind: 'domestic', standard: 42, expedited: 60, sort: 3 },
  { key: 'akhi', label: 'Alaska, Hawaii & Territories', kind: 'domestic', standard: 60, expedited: 85, sort: 4 },
  { key: 'camx', label: 'Canada & Mexico',              kind: 'intl',     standard: 35, expedited: null, sort: 5 },
  { key: 'eu',   label: 'Europe & UK',                  kind: 'intl',     standard: 50, expedited: null, sort: 6 },
];


// state -> domestic zone (code-owned coverage; Julie edits prices, not membership).
// Non-US falls back to the flat method until international ships. defaultZone
// catches an unrecognized US state.
export const SHIP_REGIONS = {
  defaultZone: 'se',
  states: { NY:'ne', NJ:'ne', CT:'ne', RI:'ne', MA:'ne', NH:'ne', VT:'ne', ME:'ne', PA:'ne', DE:'ne', MD:'ne', DC:'ne', VA:'ne', WV:'ne', OH:'ne', NC:'ne', SC:'se', GA:'se', FL:'se', AL:'se', MS:'se', TN:'se', KY:'se', IN:'se', MI:'se', IL:'se', WI:'se', MN:'se', IA:'se', MO:'se', AR:'pm', LA:'pm', TX:'pm', OK:'pm', KS:'pm', NE:'pm', SD:'pm', ND:'pm', CO:'pm', WY:'pm', MT:'pm', NM:'pm', ID:'pm', UT:'pm', AZ:'pm', NV:'wc', CA:'wc', OR:'wc', WA:'wc', AK:'akhi', HI:'akhi', PR:'akhi', VI:'akhi', GU:'akhi', AS:'akhi', MP:'akhi' },
  names: { 'alabama':'AL', 'alaska':'AK', 'arizona':'AZ', 'arkansas':'AR', 'california':'CA', 'colorado':'CO', 'connecticut':'CT', 'delaware':'DE', 'district of columbia':'DC', 'florida':'FL', 'georgia':'GA', 'hawaii':'HI', 'idaho':'ID', 'illinois':'IL', 'indiana':'IN', 'iowa':'IA', 'kansas':'KS', 'kentucky':'KY', 'louisiana':'LA', 'maine':'ME', 'maryland':'MD', 'massachusetts':'MA', 'michigan':'MI', 'minnesota':'MN', 'mississippi':'MS', 'missouri':'MO', 'montana':'MT', 'nebraska':'NE', 'nevada':'NV', 'new hampshire':'NH', 'new jersey':'NJ', 'new mexico':'NM', 'new york':'NY', 'north carolina':'NC', 'north dakota':'ND', 'ohio':'OH', 'oklahoma':'OK', 'oregon':'OR', 'pennsylvania':'PA', 'rhode island':'RI', 'south carolina':'SC', 'south dakota':'SD', 'tennessee':'TN', 'texas':'TX', 'utah':'UT', 'vermont':'VT', 'virginia':'VA', 'washington':'WA', 'west virginia':'WV', 'wisconsin':'WI', 'wyoming':'WY', 'puerto rico':'PR' },
};

// Volume discount by TOTAL print count across the order (§7). 100+ = manual quote.
export const VOLUME = [
  { min: 100, rate: null, label: 'Contact us for custom pricing' },
  { min: 50,  rate: 0.20, label: 'Save 20%' },
  { min: 25,  rate: 0.15, label: 'Save 15%' },
  { min: 10,  rate: 0.10, label: 'Save 10%' },
  { min: 1,   rate: 0.00, label: 'Standard pricing' },
];

// Hand Color Correction — flat, charged ONCE per image (not per copy) (§7).
export const CC_ADD = 15;

// DPI + preview constants (§4). Warnings are computed server-side from real
// file metadata, never trusted from the client.
export const DPI_GOOD = 240;   // at/above = "sharp"
export const DPI_MIN = 180;    // below = flagged "too small"; still orderable w/ ack
export const PX_PER_IN = 6.6;  // preview scale only

export const SETTINGS = {
  cc_add: CC_ADD,
  dpi_good: DPI_GOOD,
  dpi_min: DPI_MIN,
  px_per_in: PX_PER_IN,
  free_ship_over: 0,   // free shipping when subtotal >= this; 0 = off
};
