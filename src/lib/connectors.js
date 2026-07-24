// Cloud photo connectors (§ Phase 2).
//
// Every one of these services ultimately hands the browser a temporary URL to
// the chosen file. So the shared backend primitive is: fetch an allowlisted
// remote URL server-side, stream it into storage, and run it through the same
// validation as a direct upload. One import path, four front ends.
//
// TWO THINGS DRIVE THIS DESIGN:
//
// 1. SSRF. "Fetch this URL for me" is one of the most abused endpoints on the
//    web — an attacker who can name the URL can reach the EC2 metadata service
//    (169.254.169.254) and steal instance credentials, or probe the private
//    network. So the host must match a provider allowlist AND resolve to a
//    public address. Both checks, every time.
//
// 2. PRINT QUALITY. This is a fine-art studio. Several of these services return
//    a re-encoded derivative rather than the file the photographer created.
//    Printing a compressed 2 MP JPEG at 30×40 looks bad, and the customer will
//    blame the studio, not Google. So every provider carries an explicit
//    quality rating that follows the file into the studio queue.

export const CONNECTORS = {
  dropbox: {
    id: 'dropbox',
    label: 'Dropbox',
    // Chooser DIRECT_LINK serves the stored bytes unmodified. Dropbox is a file
    // sync service — it has no reason to re-encode anything.
    quality: 'original',
    qualityNote: 'Dropbox stores files byte-for-byte, so this is the original.',
    hosts: ['dl.dropboxusercontent.com', 'www.dropbox.com', 'dropbox.com'],
    // DIRECT_LINK expires after 4 hours; we fetch immediately anyway.
    linkTtlSeconds: 4 * 3600,
  },

  lightroom: {
    id: 'lightroom',
    label: 'Adobe Lightroom',
    // NOT ENABLED. Settled by testing, not assumption.
    //
    // /master answers 403 for EVERY asset — including one uploaded directly to
    // lightroom.adobe.com, where the original is definitively in the cloud.
    // So this is not a Lightroom Classic sync artefact and not a missing file:
    // Adobe does not grant this application access to originals. Renditions
    // cap at 2048px, and /renditions/fullsize answers 404 then 410 Gone when
    // generation is requested.
    //
    // 2048px is blocked by this studio's own DPI check at 11x14 and above —
    // most of a catalogue running to 30x40.
    //
    // Everything is built and tested. Re-enable if Adobe ever entitles the
    // integration to master asset access: ENABLED_CONNECTORS=dropbox,lightroom
    quality: 'conditional',
    qualityNote: 'Capped at 2048px — Adobe will not release originals to this application.',
    hosts: ['lr.adobe.io', 'photos.adobe.io'],
    requiresServerAuth: true,   // Adobe I/O credentials, approved integration
  },

  // NOT ENABLED BY DEFAULT — see CONNECTORS.md. Kept here so the decision is
  // visible and reversible, not so it can be switched on without thought.
  flickr: {
    id: 'flickr',
    label: 'Flickr',
    // Flickr keeps an "Original" size, but only exposes it when the owner
    // permits original-size access. Otherwise the largest available is a
    // resized derivative — fine for small prints, not for large ones.
    quality: 'conditional',
    qualityNote: 'Original size only if the Flickr account allows it; otherwise a resized copy.',
    hosts: ['live.staticflickr.com', 'farm1.staticflickr.com', 'www.flickr.com', 'flickr.com'],
  },

  // NOT ENABLED BY DEFAULT. A fine-art studio cannot stand behind a file the
  // source may have re-compressed; the studio, not Google, gets blamed for a
  // soft 30x40 print. See CONNECTORS.md.
  google_photos: {
    id: 'google_photos',
    label: 'Google Photos',
    // Two separate problems. (a) Since 31 March 2025 the library read scopes
    // are gone, so only the Picker API works — the customer must pick each
    // photo, we can't browse. (b) Google's "Storage saver" tier re-encodes on
    // upload, so the "original" may already be compressed before we ever see
    // it, and the download parameter's fidelity has been disputed for years.
    quality: 'compressed',
    qualityNote: 'Google may have re-compressed this image. Check the pixel dimensions before printing large.',
    hosts: ['lh3.googleusercontent.com', 'lh4.googleusercontent.com',
            'lh5.googleusercontent.com', 'lh6.googleusercontent.com',
            'photoslibrary.googleapis.com'],
    pickerOnly: true,
  },
};

export function getConnector(id) {
  return CONNECTORS[id] || null;
}

// Is this URL one we are willing to fetch server-side?
// Deliberately strict: https only, exact host or subdomain of an allowlisted
// host, no credentials in the URL, no non-standard ports.
export function isAllowedUrl(rawUrl, connectorId) {
  const connector = getConnector(connectorId);
  if (!connector) return { ok: false, reason: 'Unknown source.' };

  let u;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: 'Malformed URL.' }; }

  if (u.protocol !== 'https:') return { ok: false, reason: 'Only https sources are accepted.' };
  if (u.username || u.password) return { ok: false, reason: 'URL must not contain credentials.' };
  if (u.port && u.port !== '443') return { ok: false, reason: 'Non-standard ports are not accepted.' };

  const host = u.hostname.toLowerCase();
  const allowed = connector.hosts.some((h) => host === h || host.endsWith('.' + h));
  if (!allowed) return { ok: false, reason: `${host} is not a recognised ${connector.label} address.` };

  return { ok: true, url: u, connector };
}

// Defence in depth: even an allowlisted hostname could resolve to a private
// address (DNS rebinding, or a compromised provider record). Reject anything
// that isn't a public IP.
export function isPrivateAddress(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||   // cloud instance metadata — the big one
    a >= 224
  );
}
