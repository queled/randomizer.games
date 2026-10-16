/**
 * iCalendar (.ics) feeds: the events of a public calendar (Google Calendar,
 * Horaro...), with their start time in UTC.
 */

const axios = require('axios');

// "Europe/Paris" offset at that moment, in ms (positive east of UTC)
function zoneOffset(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).map(p => [p.type, p.value]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime();
}

/**
 * "20260922T010000Z", or a local time with its TZID → Date. All-day events
 * ("VALUE=DATE") have no time: null.
 */
function parseDateTime(value, params) {
  const m = String(value || '').match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/);
  if (!m) return null;
  const utc = Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]);
  const tzid = (String(params || '').match(/TZID=([^;:]+)/) || [])[1];
  if (m[7] || !tzid) return new Date(utc);
  try {
    // The offset at the local time read as UTC is right except within an hour of a DST change
    return new Date(utc - zoneOffset(new Date(utc), tzid.replace(/^"|"$/g, '')));
  } catch {
    return new Date(utc);
  }
}

function unescapeText(text) {
  return String(text || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

/** Events of an .ics text: { uid, summary, description, location, start, end } */
function parseCalendar(text) {
  // Long lines are folded: a line starting with a space or tab continues the previous one
  const lines = String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }
    if (line === 'END:VEVENT') {
      if (current && current.start) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    const [, name, params, value] = m;
    switch (name) {
      case 'UID': current.uid = value; break;
      case 'SUMMARY': current.summary = unescapeText(value).trim(); break;
      case 'DESCRIPTION': current.description = unescapeText(value); break;
      case 'LOCATION': current.location = unescapeText(value); break;
      case 'DTSTART': current.start = parseDateTime(value, params); break;
      case 'DTEND': current.end = parseDateTime(value, params); break;
    }
  }
  return events;
}

async function fetchCalendar(url) {
  const { data } = await axios.get(url, {
    timeout: 30000,
    responseType: 'text',
    headers: { 'User-Agent': 'RandomizerWebsite/1.0' }
  });
  return parseCalendar(data);
}

module.exports = { parseCalendar, fetchCalendar };
