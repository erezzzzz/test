/**
 * ============================================================================
 *  SELF-HOSTED SINGLE-USER SCHEDULING SYSTEM  (a private "Calendly" clone)
 * ============================================================================
 *  Runtime : Google Apps Script (V8 engine)
 *  Services: CalendarApp + Advanced Calendar Service ("Calendar")
 *  Mode    : Web App  ->  Execute as: Me   /   Access: Anyone
 *
 *  Code.gs — The Server Core Engine
 *  ---------------------------------------------------------------------------
 *  Structural layers implemented below:
 *    1. Centralized System Rules Configuration (CONFIG)
 *    2. Routing Engine .............. doGet()
 *    3. Conflict Calculation Engine . getAvailableSlots()
 *    4. Booking Pipeline + Mutex .... bookAppointment()
 *    5. Diagnostic helpers used by the Admin Maintenance dashboard
 *
 *  REQUIRED SETUP (one-time, inside the Apps Script editor):
 *    - Services (+)  ->  add "Google Calendar API"  (identifier: Calendar)
 *    - Deploy  ->  New deployment  ->  Web app
 *          Execute as : Me
 *          Who has access : Anyone
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
 * 1. CENTRALIZED SYSTEM RULES CONFIGURATION
 *    Every primary system invariant lives here so behavior can be tuned in one
 *    single, well-documented place.
 * ------------------------------------------------------------------------- */
var CONFIG = {
  // Business "morning" threshold (24h integer). 9 => 09:00 AM.
  workStartHour: 9,

  // Business "evening" threshold (24h integer). 17 => 05:00 PM.
  workEndHour: 17,

  // Length of a single meeting slot, in minutes.
  meetingDurationMinutes: 30,

  // Post-event padding (minutes) to prevent back-to-back fatigue.
  bufferMinutes: 15,

  // Human-facing host / event metadata (surfaced in the calendar event).
  hostName: 'Admin Host',
  eventTitle: '30 Min Technical Strategy Sync',
  eventDescriptionPrefix: 'Booked via the self-hosted scheduling web app.'
};

/* ---------------------------------------------------------------------------
 * 2. ROUTING ENGINE — doGet()
 *    Intercepts HTTP GET requests and serves the correct HTML template based
 *    on the `page` query parameter.
 *
 *      ?page=admin  -> Maintenance.html (protected diagnostic dashboard)
 *      (default)    -> Index.html       (public client scheduling view)
 * ------------------------------------------------------------------------- */
function doGet(e) {
  // Defensive: `e` / `e.parameter` can be undefined when run from the editor.
  var params = (e && e.parameter) ? e.parameter : {};
  var page = params.page || 'client';

  var templateName = (page === 'admin') ? 'Maintenance' : 'Index';

  var output = HtmlService.createHtmlOutputFromFile(templateName)
    .setTitle(page === 'admin' ? 'System Maintenance Console' : 'Schedule a Meeting')
    // Responsive viewport meta tag for a comfortable mobile experience.
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    // ALLOWALL so the app can be embedded seamlessly in the future.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  return output;
}

/**
 * Small convenience helper so the frontend can render live configuration
 * values (used by both Index.html and Maintenance.html).
 * @return {Object} A safe, serializable copy of the active configuration.
 */
function getPublicConfig() {
  return {
    workStartHour: CONFIG.workStartHour,
    workEndHour: CONFIG.workEndHour,
    meetingDurationMinutes: CONFIG.meetingDurationMinutes,
    bufferMinutes: CONFIG.bufferMinutes,
    hostName: CONFIG.hostName,
    eventTitle: CONFIG.eventTitle,
    // The admin calendar's own timezone, useful for the diagnostics panel.
    calendarTimeZone: CalendarApp.getDefaultCalendar().getTimeZone()
  };
}

/* ---------------------------------------------------------------------------
 * 3. CONFLICT CALCULATION ENGINE — getAvailableSlots()
 * ------------------------------------------------------------------------- */
/**
 * Compute all bookable slots for a given calendar date, expressed in the
 * requesting browser's timezone.
 *
 * @param {string} dateString  Target date in "YYYY-MM-DD" (browser-local).
 * @param {string} timeZone    IANA identifier, e.g. "America/New_York".
 * @return {string[]}          Array of ISO-8601 start timestamps (UTC "Z"),
 *                             each representing a valid, conflict-free slot.
 */
function getAvailableSlots(dateString, timeZone) {
  try {
    // ---- Validate inputs ---------------------------------------------------
    if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      throw new Error('Invalid date format. Expected YYYY-MM-DD.');
    }
    var tz = timeZone || Session.getScriptTimeZone();

    var parts = dateString.split('-');
    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10); // 1-12
    var day = parseInt(parts[2], 10);

    var calendar = CalendarApp.getDefaultCalendar();
    var durationMs = CONFIG.meetingDurationMinutes * 60 * 1000;
    var bufferMs = CONFIG.bufferMinutes * 60 * 1000;
    var nowMs = new Date().getTime();

    // ---- Compute the day's absolute working-window boundaries --------------
    // We build the boundary instants *in the requester's timezone* so the
    // 09:00 / 17:00 rules apply to their local day, not the server's.
    var windowStart = instantForZonedTime(year, month, day, CONFIG.workStartHour, 0, tz);
    var windowEnd = instantForZonedTime(year, month, day, CONFIG.workEndHour, 0, tz);

    // ---- Fetch every event overlapping the working window ------------------
    var events = calendar.getEvents(windowStart, windowEnd);

    // Normalize existing events into simple {start, end} millisecond ranges.
    var busyRanges = events.map(function (ev) {
      return {
        start: ev.getStartTime().getTime(),
        end: ev.getEndTime().getTime()
      };
    });

    // ---- Deterministic time-slice looping matrix ---------------------------
    var slots = [];
    var cursor = windowStart.getTime();
    var endBoundary = windowEnd.getTime();

    while (cursor + durationMs <= endBoundary) {
      var sliceStart = cursor;
      var sliceEnd = cursor + durationMs;

      // Gate #1: the *entire* window must sit in the future.
      var isFuture = sliceStart > nowMs;

      // Gate #2: the slice (padded with the trailing buffer) must not collide
      // with any existing event. We treat the buffer as belonging AFTER the
      // slice so meetings never end flush against the next commitment.
      var isFree = true;
      if (isFuture) {
        for (var i = 0; i < busyRanges.length; i++) {
          var b = busyRanges[i];
          // Standard half-open overlap test, extended by the buffer padding.
          if (sliceStart < (b.end + bufferMs) && (sliceEnd + bufferMs) > b.start) {
            isFree = false;
            break;
          }
        }
      }

      if (isFuture && isFree) {
        // Normalize to ISO-8601 (UTC "Z") to prevent localization distortion.
        slots.push(new Date(sliceStart).toISOString());
      }

      // Advance one full meeting duration to the next candidate slice.
      cursor += durationMs;
    }

    return slots;
  } catch (err) {
    // Surface a clean, structured error the frontend can render.
    throw new Error('getAvailableSlots failed: ' + err.message);
  }
}

/* ---------------------------------------------------------------------------
 * 4. BOOKING PIPELINE + MUTEX LOCK SAFEGUARD — bookAppointment()
 * ------------------------------------------------------------------------- */
/**
 * Atomically book a slot, generating a Google Meet link.
 *
 * @param {Object} payload
 * @param {string} payload.name   Client full name.
 * @param {string} payload.email  Client email (added as an attendee).
 * @param {string} payload.notes  Free-form context notes.
 * @param {string} payload.slot   ISO-8601 start timestamp (from getAvailableSlots).
 * @param {string} payload.timeZone  IANA tz used purely for confirmation text.
 * @return {Object} { success, meetLink, eventId, startIso, message }
 */
function bookAppointment(payload) {
  // ---- Acquire a strict per-user mutex (race-condition gate) ---------------
  var lock = LockService.getUserLock();
  try {
    // Attempt to hold the lock for up to 10 seconds. If we can't, fail safely
    // so two simultaneous double-clicks never corrupt the calendar grid.
    if (!lock.tryLock(10000)) {
      throw new Error('The system is busy handling another booking. Please try again in a moment.');
    }

    // ---- Validate the incoming payload ------------------------------------
    if (!payload || typeof payload !== 'object') {
      throw new Error('Missing booking payload.');
    }
    var name = (payload.name || '').toString().trim();
    var email = (payload.email || '').toString().trim();
    var notes = (payload.notes || '').toString().trim();
    var slotIso = (payload.slot || '').toString().trim();

    if (!name) throw new Error('Please provide your full name.');
    if (!isValidEmail(email)) throw new Error('Please provide a valid email address.');
    if (!slotIso) throw new Error('No time slot was selected.');

    var start = new Date(slotIso);
    if (isNaN(start.getTime())) throw new Error('The selected time slot is invalid.');

    var startMs = start.getTime();
    var endMs = startMs + CONFIG.meetingDurationMinutes * 60 * 1000;
    var end = new Date(endMs);
    var bufferMs = CONFIG.bufferMinutes * 60 * 1000;

    // ---- Secondary real-time re-check (inside the lock) --------------------
    // Guards against another instance capturing the slice while this client
    // was still filling out the form.
    if (startMs <= new Date().getTime()) {
      throw new Error('That time slot is already in the past. Please pick a new time.');
    }

    var calendar = CalendarApp.getDefaultCalendar();
    var conflicts = calendar.getEvents(new Date(startMs - bufferMs), new Date(endMs + bufferMs));
    for (var i = 0; i < conflicts.length; i++) {
      var cs = conflicts[i].getStartTime().getTime();
      var ce = conflicts[i].getEndTime().getTime();
      if (startMs < (ce + bufferMs) && (endMs + bufferMs) > cs) {
        throw new Error('Sorry — that slot was just booked by someone else. Please choose another time.');
      }
    }

    // ---- Advanced Event Builder -------------------------------------------
    var calendarId = calendar.getId();
    var requestId = 'meet-' + startMs + '-' + Utilities.getUuid().slice(0, 8);

    var eventResource = {
      summary: CONFIG.eventTitle + ' — ' + name,
      description:
        CONFIG.eventDescriptionPrefix + '\n\n' +
        'Guest: ' + name + '\n' +
        'Email: ' + email + '\n' +
        'Notes: ' + (notes || '(none provided)'),
      start: {
        dateTime: start.toISOString(),
        timeZone: 'UTC'
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: 'UTC'
      },
      attendees: [
        { email: email, displayName: name }
      ],
      // ---- Video Call Injection (Google Meet) ------------------------------
      conferenceData: {
        createRequest: {
          requestId: requestId,
          conferenceSolutionKey: {
            type: 'hangoutsMeet'
          }
        }
      }
    };

    // ---- Write with conferenceDataVersion=1 so Meet is actually generated --
    var createdEvent = Calendar.Events.insert(
      eventResource,
      calendarId,
      { conferenceDataVersion: 1, sendUpdates: 'all' }
    );

    // ---- Extract the generated Google Meet link ---------------------------
    var meetLink = '';
    if (createdEvent.conferenceData && createdEvent.conferenceData.entryPoints) {
      var entries = createdEvent.conferenceData.entryPoints;
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].entryPointType === 'video' && entries[j].uri) {
          meetLink = entries[j].uri;
          break;
        }
      }
      // Fallback to the first entry point if no explicit "video" type is found.
      if (!meetLink && entries.length > 0 && entries[0].uri) {
        meetLink = entries[0].uri;
      }
    }
    // Final fallback: the event's own hangout link, if present.
    if (!meetLink && createdEvent.hangoutLink) {
      meetLink = createdEvent.hangoutLink;
    }

    return {
      success: true,
      meetLink: meetLink,
      eventId: createdEvent.id,
      startIso: start.toISOString(),
      message: 'Your meeting has been confirmed.'
    };
  } catch (err) {
    // Re-throw with a clean, user-facing message so google.script.run's
    // failure handler receives something presentable.
    throw new Error(err.message);
  } finally {
    // ---- Finalizer: always release the mutex ------------------------------
    // Guarantees no server resource hangs indefinitely.
    try {
      lock.releaseLock();
    } catch (releaseErr) {
      // Nothing actionable if release fails; swallow to avoid masking errors.
    }
  }
}

/* ---------------------------------------------------------------------------
 * 5. DIAGNOSTIC HELPERS (consumed by Maintenance.html)
 * ------------------------------------------------------------------------- */

/**
 * Verify that the admin's default calendar is reachable.
 * @return {Object} { ok, name, timeZone, latencyMs }
 */
function diagTestCalendar() {
  var t0 = new Date().getTime();
  try {
    var cal = CalendarApp.getDefaultCalendar();
    var name = cal.getName();
    var tz = cal.getTimeZone();
    return {
      ok: true,
      name: name,
      timeZone: tz,
      latencyMs: new Date().getTime() - t0
    };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: new Date().getTime() - t0 };
  }
}

/**
 * Measure how quickly the LockService can grant + release a user lock.
 * @return {Object} { ok, latencyMs }
 */
function diagTestLockLatency() {
  var t0 = new Date().getTime();
  var lock = LockService.getUserLock();
  try {
    var granted = lock.tryLock(2000);
    var latency = new Date().getTime() - t0;
    if (!granted) {
      return { ok: false, error: 'Could not acquire lock within 2000ms.', latencyMs: latency };
    }
    return { ok: true, latencyMs: latency };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: new Date().getTime() - t0 };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* no-op */ }
  }
}

/**
 * Purge transient cache settings for the current user + script scopes.
 * @return {Object} { ok, cleared }
 */
function diagPurgeCache() {
  try {
    var cleared = [];
    var userCache = CacheService.getUserCache();
    if (userCache) { userCache.removeAll(['__probe__']); cleared.push('user'); }
    var scriptCache = CacheService.getScriptCache();
    if (scriptCache) { scriptCache.removeAll(['__probe__']); cleared.push('script'); }
    return { ok: true, cleared: cleared };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------------------------------------------------------------------------
 * INTERNAL UTILITIES
 * ------------------------------------------------------------------------- */

/**
 * Build the absolute Date instant for a wall-clock time in a specific IANA
 * timezone. Apps Script has no direct "zoned time -> instant" constructor, so
 * we derive the zone's UTC offset for that calendar day and apply it.
 *
 * @param {number} year
 * @param {number} month  1-12
 * @param {number} day
 * @param {number} hour   0-23 (wall-clock time in `tz`)
 * @param {number} minute 0-59
 * @param {string} tz     IANA timezone identifier
 * @return {Date} the corresponding absolute instant
 */
function instantForZonedTime(year, month, day, hour, minute, tz) {
  // First guess: interpret the wall-clock components as if they were UTC.
  var guessUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

  // Ask Apps Script what UTC offset `tz` has at (approximately) that instant.
  // Utilities.formatDate renders the guess instant *in tz* and emits the
  // numeric offset ("Z" format => e.g. "-0400").
  var offsetStr = Utilities.formatDate(new Date(guessUtc), tz, 'Z'); // e.g. "-0400"
  var offsetMinutes = parseGmtOffsetToMinutes(offsetStr);

  // The real instant is the UTC guess minus the zone offset.
  // (If tz is UTC-4, local 09:00 == 13:00 UTC, so we ADD 4 hours => subtract a
  //  negative offset.)
  return new Date(guessUtc - offsetMinutes * 60 * 1000);
}

/**
 * Parse a "+HHMM" / "-HHMM" GMT offset string into signed minutes.
 * @param {string} offsetStr e.g. "-0400" or "+0530"
 * @return {number} signed minutes
 */
function parseGmtOffsetToMinutes(offsetStr) {
  var sign = offsetStr.charAt(0) === '-' ? -1 : 1;
  var hh = parseInt(offsetStr.substring(1, 3), 10);
  var mm = parseInt(offsetStr.substring(3, 5), 10);
  return sign * (hh * 60 + mm);
}

/**
 * Lightweight email validation (defensive; not RFC-exhaustive).
 * @param {string} email
 * @return {boolean}
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
