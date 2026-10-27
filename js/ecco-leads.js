/* Ecco lead delivery — shared by every quote flow and the privacy request form.
 *
 * GO-LIVE: Philip creates a free access key at https://web3forms.com using his
 * lead email address, then pastes the key below in place of '24f8ecbd-34aa-45b7-b074-ab73d2764552'.
 * The email address itself never goes in this repo; Web3Forms maps key -> inbox.
 * While the key is '24f8ecbd-34aa-45b7-b074-ab73d2764552', submissions are NOT sent: a console warning is
 * logged and the success screen is still shown so the site can be previewed.
 */
var LEAD_FORM_ACCESS_KEY = '24f8ecbd-34aa-45b7-b074-ab73d2764552';
var LEAD_FORM_ENDPOINT = 'https://api.web3forms.com/submit';

(function () {
  var answers = {};          // question -> chosen option(s), captured from clicks
  function txt(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
  function questionFor(el) {
    var scr = el.closest('.scr, .builder, section, .fcard') || document.body;
    var h = scr.querySelector('.qtitle, h1.q, h1, h2, h3');
    return txt(h) || (scr.id || 'Question');
  }
  document.addEventListener('click', function (e) {
    var opt = e.target.closest && e.target.closest('.scr .opt, .scr .rate-opt, .q-opt');
    if (!opt || opt.id === 'pay-full' || opt.id === 'pay-fin') return;
    var name = txt(opt.querySelector('.oname')) || txt(opt);
    if (name) answers[questionFor(opt)] = name;
  }, true);

  function inputsIn(root, skip) {
    var out = {};
    root.querySelectorAll('input, select, textarea').forEach(function (i) {
      if (i.type === 'file' || i.type === 'checkbox' || i.type === 'radio' || (i.type === 'range' && !i.id)) return;
      if (!i.value || (skip && skip.contains(i))) return;
      var lab = i.closest('.ff') && i.closest('.ff').querySelector('label');
      var key = txt(lab) || i.getAttribute('aria-label') || i.placeholder || i.id || i.name;
      out[key] = i.value;
    });
    return out;
  }
  function pickByType(root, sel) { var el = root.querySelector(sel); return el ? el.value.trim() : ''; }

  function addConsent(root) {
    if (root.querySelector('.lead-consent')) return;
    var l = document.createElement('label');
    l.className = 'lead-consent';
    l.style.cssText = 'display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.5;color:var(--muted,#5b6b80);margin-top:14px;cursor:pointer;';
    l.innerHTML = '<input type="checkbox" class="lead-consent-chk" style="margin-top:3px;flex-shrink:0;width:auto;">' +
      '<span>I agree that Ecco can share my details with one or more local installers so they can quote for this work. See our <a href="privacy.html" target="_blank" style="color:var(--blue,#0088bb);text-decoration:underline;">privacy notice</a>.</span>';
    root.appendChild(l);
    var m = document.createElement('div');
    m.className = 'lead-msg';
    m.setAttribute('role', 'alert');
    m.style.cssText = 'display:none;font-size:13px;line-height:1.5;margin-top:10px;color:#b42318;';
    root.appendChild(m);
  }
  function msg(root, t) { var m = root.querySelector('.lead-msg'); if (m) { m.textContent = t || ''; m.style.display = t ? 'block' : 'none'; } }

  /* opts: { flow, contact: Element, extra: {}, button: Element, subject, requireConsent (default true),
             onSuccess: fn }  -> returns Promise<boolean> */
  function submit(opts) {
    var root = opts.contact;
    var contact = {
      first_name: pickByType(root, 'input[placeholder="Sarah"], input[name="first_name"]'),
      last_name: pickByType(root, 'input[placeholder="Miller"], input[name="last_name"]'),
      email: pickByType(root, 'input[type="email"]'),
      phone: pickByType(root, 'input[type="tel"]'),
      postcode: pickByType(root, 'input[autocomplete="postal-code"], input[placeholder="BL1 2AB"], input[name="postcode"]')
    };
    if (!contact.first_name && !pickByType(root, 'input[name="name"]')) { msg(root, 'Please add your name.'); return Promise.resolve(false); }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email)) { msg(root, 'Please add a valid email address.'); return Promise.resolve(false); }
    if (opts.requirePhone !== false && !contact.phone) { msg(root, 'Please add a mobile number so the installer can reach you.'); return Promise.resolve(false); }
    var chk = root.querySelector('.lead-consent-chk');
    if (opts.requireConsent !== false && (!chk || !chk.checked)) { msg(root, 'Please tick the box to agree to us sharing your details with local installers.'); return Promise.resolve(false); }
    msg(root, '');

    var payload = {
      access_key: LEAD_FORM_ACCESS_KEY,
      subject: opts.subject || ('New Ecco lead: ' + opts.flow),
      from_name: 'Ecco website',
      flow: opts.flow,
      page: location.pathname,
      submitted_at: new Date().toISOString(),
      consent_to_share_with_installers: chk ? (chk.checked ? 'yes' : 'no') : 'n/a',
      botcheck: ''
    };
    Object.keys(contact).forEach(function (k) { if (contact[k]) payload[k] = contact[k]; });
    var nm = pickByType(root, 'input[name="name"]'); if (nm) payload.name = nm;
    else payload.name = (contact.first_name + ' ' + contact.last_name).trim();
    if (contact.email) payload.replyto = contact.email;
    var ans = Object.keys(answers).map(function (q) { return q + ': ' + answers[q]; }).join('\n');
    if (ans) payload.answers = ans;
    if (opts.scope) { var fi = inputsIn(opts.scope, root); var fk = Object.keys(fi); if (fk.length) payload.form_fields = fk.map(function (k) { return k + ': ' + fi[k]; }).join('\n'); }
    var extra = opts.extra || {};
    Object.keys(extra).forEach(function (k) { if (extra[k] !== '' && extra[k] != null) payload[k] = typeof extra[k] === 'object' ? JSON.stringify(extra[k]) : String(extra[k]); });

    var btn = opts.button, old = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = 'Sending…'; }
    function done(ok) {
      if (btn) { btn.disabled = false; btn.innerHTML = old; }
      if (ok) { if (opts.onSuccess) opts.onSuccess(payload); }
      else msg(root, 'Sorry, something went wrong sending your request. Please check your connection and try again.');
      return ok;
    }
    if (LEAD_FORM_ACCESS_KEY === 'REPLACE_ME') {
      console.warn('[Ecco] LEAD_FORM_ACCESS_KEY not set in js/ecco-leads.js. Lead NOT sent (preview mode). Payload:', payload);
      return Promise.resolve(done(true));
    }
    return fetch(LEAD_FORM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return done(r.ok && j.success !== false); }); })
      .catch(function () { return done(false); });
  }

  window.EccoLeads = { submit: submit, addConsent: addConsent, answers: answers };
})();
