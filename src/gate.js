// Sign-in gate: company email + one-time code, first-time setup, request access.
// startGate(api, mode) resolves with the signed-in, set-up profile.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MSG = {
  not_allowed: "That email is not allowed to sign in. Use your company email, or request access.",
  name_needed: "Enter your full name.", unit_needed: "Choose your unit.", department_needed: "Choose your department.",
  bad_request: "Enter your full name and a valid email.", contact_needed: "Add a WhatsApp number or phone so Group Strategy can reach you.",
  rate_limited: "Too many requests. Try again later.", already_registered: "That email already has access. Go back and sign in.",
};
export function startGate(api, current) {
  return new Promise((resolve) => {
    const root = document.getElementById("gateRoot");
    const local = api.mode === "local";
    let email = "", units = null;
    const done = (p) => { root.innerHTML = ""; root.hidden = true; document.body.classList.remove("gated"); resolve(p); };
    root.hidden = false; document.body.classList.add("gated");
    const shell = (inner) => { root.innerHTML = `<div class="gate"><div class="gate-card"><div class="gate-brand"><span class="gate-dot"></span><b>Wagwago Business Group</b></div><h1>Weekly Activity Tracking</h1>${inner}</div></div>`; };
    const err = (m) => { const e = root.querySelector(".gate-err"); if (e) e.textContent = m || ""; };
    const busy = (b, on, label) => { if (b) { b.disabled = on; if (label) b.textContent = label; } };

    async function loadUnits() { if (!units) { try { units = await api.publicUnits(); } catch (e) { units = []; } } return units; }

    const stayBox = (checked = true) => `<label class="gate-stay"><input type="checkbox" id="gStay" ${checked ? "checked" : ""}> Stay signed in on this device</label>`;
    const stay = () => { const b = root.querySelector("#gStay"); return b ? b.checked : true; };
    const personaBox = () => local ? `<div class="gate-local"><div class="small muted">Test mode: pick a person to sign in as, no email is sent.</div><select id="gPersona"><option value="">Choose a person…</option>${api.localPeople().map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.email)} · ${esc(p.role)}</option>`).join("")}</select></div>` : "";
    const wirePersona = () => { const ps = root.querySelector("#gPersona"); if (ps) ps.onchange = async () => { if (!ps.value) return; const p = api.localSignIn(ps.value); await after(p); }; };

    // Main screen: email and password
    function screenEmail(prefill) {
      shell(`<p class="muted">Sign in with your email and password.</p>
        <form id="gForm"><label for="gEmail">Email</label><input id="gEmail" type="email" autocomplete="username" placeholder="name@company.com" value="${esc(prefill || "")}" required>
        <label for="gPass">Password</label><input id="gPass" type="password" autocomplete="current-password" required>
        ${stayBox()}
        <div class="gate-err small" role="alert"></div><button class="btn primary" type="submit">Sign in</button></form>
        <div class="small" style="margin-top:14px"><a href="#" id="gCode">First time, or forgot your password? Get a code by email</a></div>
        <div class="small muted" style="margin-top:8px">No access yet? <a href="#" id="gReq">Request access</a></div>${personaBox()}`);
      const inp = root.querySelector("#gEmail"); (prefill ? root.querySelector("#gPass") : inp).focus();
      root.querySelector("#gReq").onclick = (e) => { e.preventDefault(); screenRequest(inp.value); };
      root.querySelector("#gCode").onclick = (e) => { e.preventDefault(); screenCodeStart(inp.value); };
      wirePersona();
      root.querySelector("#gForm").onsubmit = async (e) => {
        e.preventDefault(); const b = e.submitter; busy(b, true, "Signing in…"); err("");
        email = inp.value.trim().toLowerCase();
        let r; try { r = await api.signInPassword(email, root.querySelector("#gPass").value, stay()); } catch (x) { r = { error: "network" }; }
        busy(b, false, "Sign in");
        if (r.error === "network") return err("Could not reach the server. Check your connection.");
        if (r.error) return err(/rate|too many/i.test(r.error) ? "Too many tries. Wait a few minutes and try again." : "That email or password is not right. If you have not set a password yet, get a code by email.");
        await after(r.profile);
      };
    }

    // Code route: first time, or forgot password
    function screenCodeStart(prefill) {
      shell(`<p class="muted">We send a one-time code to your email. After you enter it you choose a password for next time.</p>
        <form id="gForm"><label for="gEmail">Email</label><input id="gEmail" type="email" autocomplete="email" placeholder="name@company.com" value="${esc(prefill || "")}" required>
        <div class="gate-err small" role="alert"></div><button class="btn primary" type="submit">Send code</button></form>
        <div class="small" style="margin-top:14px"><a href="#" id="gBack">Back to sign in</a> · <a href="#" id="gReq">Request access</a></div>`);
      const inp = root.querySelector("#gEmail"); inp.focus();
      root.querySelector("#gBack").onclick = (e) => { e.preventDefault(); screenEmail(inp.value); };
      root.querySelector("#gReq").onclick = (e) => { e.preventDefault(); screenRequest(inp.value); };
      root.querySelector("#gForm").onsubmit = async (e) => {
        e.preventDefault(); email = inp.value.trim().toLowerCase(); const b = e.submitter; busy(b, true, "Checking…"); err("");
        let ck; try { ck = await api.checkEmail(email); } catch (x) { ck = { error: "network" }; }
        if (ck.error === "network") { busy(b, false, "Send code"); return err("Could not reach the server. Check your connection."); }
        if (!ck.allowed) { busy(b, false, "Send code"); return err(MSG.not_allowed); }
        const r = await api.sendCode(email);
        busy(b, false, "Send code");
        if (r.error) return err(r.status === 429 ? "Too many codes sent. Wait a few minutes, then try again." : "Could not send the code: " + r.error);
        screenCode();
      };
    }

    function screenCode() {
      shell(`<p>We sent a code to <b>${esc(email)}</b>. Enter it below. It can take a minute to arrive; check spam.</p>
        <form id="gForm"><label for="gCode">One-time code</label><input id="gCode" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="Code" required>
        ${stayBox()}
        <div class="gate-err small" role="alert"></div><button class="btn primary" type="submit">Continue</button></form>
        <div class="small" style="margin-top:14px"><a href="#" id="gResend">Send a new code</a> · <a href="#" id="gBack">Use a different email</a></div>${local ? '<div class="small muted" style="margin-top:8px">Test mode: any code works.</div>' : ""}`);
      const inp = root.querySelector("#gCode"); inp.focus();
      root.querySelector("#gBack").onclick = (e) => { e.preventDefault(); screenCodeStart(email); };
      root.querySelector("#gResend").onclick = async (e) => { e.preventDefault(); const r = await api.sendCode(email); err(r.error ? "Could not send: " + r.error : "A new code was sent."); };
      root.querySelector("#gForm").onsubmit = async (e) => {
        e.preventDefault(); const b = e.submitter; busy(b, true, "Checking…"); err("");
        api.setRemember(stay());
        const r = await api.verifyCode(email, inp.value.trim()); busy(b, false, "Continue");
        if (r.error) return err("That code is not right or has expired. Check it or send a new one.");
        // Always ask for a password after a code: either it is the first time, or the person forgot it
        if (r.profile && r.profile.status === "active") return screenPassword(r.profile);
        await after(r.profile);
      };
    }

    // Choose a password (after a code sign-in)
    async function screenPassword(p) {
      let has = false; try { has = await api.hasPassword(); } catch (x) {}
      shell(`<p><b>${has ? "Choose a new password" : "Create your password"}</b></p><p class="small muted">Use it with your email next time, so you do not need a code. At least 10 characters; a short sentence is a good password.</p>
        <form id="gForm"><label for="pw1">New password</label><input id="pw1" type="password" autocomplete="new-password" required minlength="10">
        <label for="pw2">Repeat it</label><input id="pw2" type="password" autocomplete="new-password" required minlength="10">
        <div class="gate-err small" role="alert"></div><button class="btn primary" type="submit">Save password</button></form>
        <div class="small" style="margin-top:14px"><a href="#" id="gSkip">Skip for now</a> (you will use a code next time)</div>`);
      root.querySelector("#pw1").focus();
      root.querySelector("#gSkip").onclick = async (e) => { e.preventDefault(); await after(p); };
      root.querySelector("#gForm").onsubmit = async (e) => {
        e.preventDefault(); const a = root.querySelector("#pw1").value, c = root.querySelector("#pw2").value, b = e.submitter;
        if (a.length < 10) return err("Use at least 10 characters.");
        if (a !== c) return err("The two passwords are not the same.");
        if (/^(.)\1+$/.test(a) || /^(1234567890|password12|qwertyuiop)/i.test(a)) return err("Choose something less guessable.");
        busy(b, true, "Saving…"); const r = await api.setPassword(a); busy(b, false, "Save password");
        if (r.error) return err(/same|different/i.test(r.error) ? "Choose a password you have not used before." : "Could not save the password: " + r.error);
        await after(p);
      };
    }

    async function after(p) {
      if (!p || p.status === "none") return screenStatus("none");
      if (p.status === "disabled") return screenStatus("disabled");
      if (!p.setupDone) return screenSetup(p);
      done(p);
    }

    function screenStatus(kind) {
      shell(kind === "disabled"
        ? `<p><b>Your access is switched off.</b> Contact Group Strategy to have it restored.</p>`
        : `<p><b>This email has no access yet.</b> Request access and Group Strategy will review it.</p>`);
      const b = document.createElement("div"); b.className = "toolbar"; b.style.marginTop = "14px";
      b.innerHTML = `<button class="btn" id="gOut">Use another email</button>${kind === "none" ? '<button class="btn primary" id="gReq2">Request access</button>' : ""}`;
      root.querySelector(".gate-card").append(b);
      root.querySelector("#gOut").onclick = async () => { await api.signOut(); screenEmail(); };
      const r2 = root.querySelector("#gReq2"); if (r2) r2.onclick = () => screenRequest(email);
    }

    async function screenSetup(p) {
      const list = await loadUnits(), invited = !!p.invited;
      shell(`<p>${invited ? "Welcome. Confirm your name to finish." : "Welcome. Tell us who you are to finish setting up."}</p>
        <form id="gForm"><label for="sName">Full name</label><input id="sName" value="${esc(p.name || "")}" maxlength="60" autocomplete="name" required>
        ${invited ? `<div class="small muted" style="margin-top:8px">Your access: <b>${esc(p.role)}</b>${p.unit ? " · " + esc((list.find((u) => u.id === p.unit) || {}).name || p.unit) : ""}${(p.departments || []).length ? " · " + esc(p.departments.join(", ")) : ""}</div>` : `
        <label for="sUnit">Your unit</label><select id="sUnit"><option value="">Choose your unit</option>${list.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("")}</select>
        <div id="sDeptWrap" hidden><label for="sDept">Your department</label><select id="sDept"></select></div>
        <div class="small muted" style="margin-top:8px">You start with update access to your own department. Group Strategy can change your role.</div>`}
        <div class="gate-err small" role="alert"></div><button class="btn primary" type="submit">Continue</button></form>
        <div class="small" style="margin-top:14px"><a href="#" id="gOut">Sign out</a></div>`);
      const unitSel = root.querySelector("#sUnit");
      if (unitSel) unitSel.onchange = () => {
        const u = list.find((x) => x.id === unitSel.value), ds = (u && u.departments) || [], w = root.querySelector("#sDeptWrap");
        w.hidden = !ds.length; root.querySelector("#sDept").innerHTML = `<option value="">Choose your department</option>` + ds.map((d) => `<option>${esc(d)}</option>`).join("");
      };
      root.querySelector("#gOut").onclick = async (e) => { e.preventDefault(); await api.signOut(); screenEmail(); };
      root.querySelector("#gForm").onsubmit = async (e) => {
        e.preventDefault(); const b = e.submitter; busy(b, true, "Saving…");
        const unit = unitSel ? unitSel.value : "", d = root.querySelector("#sDept"), deps = d && d.value ? [d.value] : [];
        const r = await api.completeSignup(root.querySelector("#sName").value.trim(), unit, deps);
        busy(b, false, "Continue");
        if (r.error) return err(MSG[r.error] || "Could not finish setup: " + r.error);
        done(r.profile);
      };
    }

    async function screenRequest(prefill) {
      const list = await loadUnits();
      shell(`<p>Not on a company email list? Ask Group Strategy for access. They will contact you.</p>
        <form id="gForm"><label for="rName">Full name</label><input id="rName" maxlength="60" required>
        <label for="rEmail">Email</label><input id="rEmail" type="email" value="${esc(prefill || "")}" required>
        <label for="rUnit">Your unit</label><select id="rUnit"><option value="">Choose your unit</option>${list.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("")}</select>
        <label for="rContact">WhatsApp or phone</label><input id="rContact" maxlength="40" required>
        <label for="rNote">Note (optional)</label><input id="rNote" maxlength="200">
        <div class="gate-err small" role="alert"></div><button class="btn primary" type="submit">Send request</button></form>
        <div class="small" style="margin-top:14px"><a href="#" id="gBack">Back to sign in</a></div>`);
      root.querySelector("#gBack").onclick = (e) => { e.preventDefault(); screenEmail(); };
      root.querySelector("#gForm").onsubmit = async (e) => {
        e.preventDefault(); const b = e.submitter; busy(b, true, "Sending…");
        const r = await api.requestAccess({ name: root.querySelector("#rName").value, email: root.querySelector("#rEmail").value, unit: root.querySelector("#rUnit").value, contact: root.querySelector("#rContact").value, note: root.querySelector("#rNote").value });
        busy(b, false, "Send request");
        if (r && r.error) return err(MSG[r.error] || "Could not send: " + r.error);
        shell(`<p><b>Request sent.</b> Group Strategy will review it and contact you.</p><button class="btn" id="gBack">Back to sign in</button>`);
        root.querySelector("#gBack").onclick = () => screenEmail();
      };
    }

    if (current) after(current); else screenEmail();
  });
}
