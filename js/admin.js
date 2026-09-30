/* ==========================================================================
   RAPI COIFFURE — ADMIN PAGE (admin.html)
   Lists appointment requests. For each one you can:
     • Confirm  → enter the amount to pay → status "confirmed" + opens WhatsApp
                   with a confirmation AND a secure payment link for the client
                   (leave the amount empty = the client pays at the shop)
     • Cancel   → status "cancelled" (the time slot becomes free again)
                   + opens WhatsApp with a message for the client
     • Resend payment link / Mark as paid (e.g. paid in cash at the shop)
   ⚠ In demo mode (localStorage) this page only shows requests made in THIS browser.
   With the Supabase database it shows every request (admin login required, see README).
   ========================================================================== */
(function () {
    "use strict";

    // Country code added to client numbers written without one (e.g. "079 123 45 67")
    const DEFAULT_COUNTRY_CODE = "41";

    const ui = {
        fr: {
            title: "Demandes de rendez-vous",
            demo: "Mode démo : cette page affiche uniquement les demandes enregistrées dans ce navigateur. Une fois la base de données connectée, toutes les demandes apparaîtront ici.",
            pending: "En attente", upcoming: "À venir", all: "Toutes",
            confirm: "Confirmer", cancel: "Annuler", message: "Écrire au client",
            confirmed: "Confirmé", cancelled: "Annulé", waiting: "En attente de confirmation",
            empty: "Aucune demande pour le moment.",
            askCancel: "Annuler ce rendez-vous ? Le créneau redeviendra disponible.",
            error: "Action impossible. Vérifiez la connexion à la base de données.",
            password: "Mot de passe", login: "Se connecter", loginFailed: "E-mail ou mot de passe incorrect.",
            amount: "Montant à payer en ligne (CHF)", amountHint: "Laissez vide si le client paie au salon.",
            sendConfirm: "Confirmer et envoyer", back: "Retour",
            paid: "Payé", unpaid: "Non payé", payInShop: "Paiement au salon",
            resend: "Renvoyer le lien de paiement", markPaid: "Marquer comme payé",
            askMarkPaid: "Marquer ce rendez-vous comme payé (ex. payé au salon) ?",
            askCancelPaid: "Ce rendez-vous est déjà payé. L'annuler quand même ? Pensez à rembourser le client dans Stripe."
        },
        en: {
            title: "Appointment requests",
            demo: "Demo mode: this page only shows requests saved in this browser. Once the database is connected, every request will appear here.",
            pending: "Pending", upcoming: "Upcoming", all: "All",
            confirm: "Confirm", cancel: "Cancel", message: "Message client",
            confirmed: "Confirmed", cancelled: "Cancelled", waiting: "Pending confirmation",
            empty: "No requests yet.",
            askCancel: "Cancel this appointment? The time slot will become available again.",
            error: "Action failed. Check the database connection.",
            password: "Password", login: "Log in", loginFailed: "Wrong email or password.",
            amount: "Amount to pay online (CHF)", amountHint: "Leave empty if the client pays at the shop.",
            sendConfirm: "Confirm and send", back: "Back",
            paid: "Paid", unpaid: "Unpaid", payInShop: "Pay at the shop",
            resend: "Resend payment link", markPaid: "Mark as paid",
            askMarkPaid: "Mark this appointment as paid (e.g. paid at the shop)?",
            askCancelPaid: "This appointment is already paid. Cancel it anyway? Remember to refund the client in Stripe."
        }
    };

    // Messages sent to the CLIENT, in the language they booked in
    const clientMessages = {
        fr: {
            confirmed: b => `Bonjour ${b.customer.name},\n\nVotre rendez-vous chez ${businessSettings.businessName} est confirmé.\n\nService: ${serviceName(b, "fr")}\nDate: ${fmtDate(b.date)}\nHeure: ${b.time}` +
                (payLink(b) ? `\nMontant: CHF ${money(b.amount)}\n\nPayez en ligne en toute sécurité (${paymentSettings.methods}) :\n${payLink(b)}` : "") +
                `\n\nRéférence: ${b.id}\nÀ bientôt !`,
            payment: b => `Bonjour ${b.customer.name},\n\nVoici le lien pour régler votre rendez-vous du ${fmtDate(b.date)} à ${b.time} (CHF ${money(b.amount)}) :\n${payLink(b)}\n\nRéférence: ${b.id}\n${businessSettings.businessName}`,
            cancelled: b => `Bonjour ${b.customer.name},\n\nNous sommes désolés, votre demande de rendez-vous du ${fmtDate(b.date)} à ${b.time} ne peut pas être acceptée. Souhaitez-vous un autre horaire ?\n\nRéférence: ${b.id}\n${businessSettings.businessName}`,
            message: b => `Bonjour ${b.customer.name}, `
        },
        en: {
            confirmed: b => `Hello ${b.customer.name},\n\nYour appointment at ${businessSettings.businessName} is confirmed.\n\nService: ${serviceName(b, "en")}\nDate: ${fmtDate(b.date)}\nTime: ${b.time}` +
                (payLink(b) ? `\nAmount: CHF ${money(b.amount)}\n\nPay securely online (${paymentSettings.methods}):\n${payLink(b)}` : "") +
                `\n\nReference: ${b.id}\nSee you soon!`,
            payment: b => `Hello ${b.customer.name},\n\nHere is the link to pay for your appointment on ${fmtDate(b.date)} at ${b.time} (CHF ${money(b.amount)}):\n${payLink(b)}\n\nReference: ${b.id}\n${businessSettings.businessName}`,
            cancelled: b => `Hello ${b.customer.name},\n\nWe're sorry, your appointment request for ${fmtDate(b.date)} at ${b.time} can't be accepted. Would another time work for you?\n\nReference: ${b.id}\n${businessSettings.businessName}`,
            message: b => `Hello ${b.customer.name}, `
        }
    };

    let lang = "fr";
    try { lang = localStorage.getItem("rapi-coiffure-lang") || "fr"; } catch (e) { /* ignore */ }
    if (!ui[lang]) lang = "fr";
    let filter = "pending";
    let bookings = [];

    const $ = s => document.querySelector(s);
    const t = k => ui[lang][k];
    const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    function serviceName(b, l) {
        const s = services.find(sv => sv.id === b.serviceId);
        return s ? (s.name[l] || s.name.fr) : b.serviceName;
    }
    const money = n => Number(n).toFixed(2).replace(/\.00$/, "");
    // Link to the payment page, or "" when no online payment applies
    function payLink(b) {
        if (!paymentSettings.enabled || !b.payToken || !(b.amount > 0) || b.paymentStatus === "paid") return "";
        const base = paymentSettings.payPageUrl || new URL("pay.html", location.href).href.split("?")[0];
        return `${base}?t=${encodeURIComponent(b.payToken)}`;
    }
    function defaultPrice(b) {
        const s = services.find(sv => sv.id === b.serviceId);
        return s && s.price != null ? s.price : "";
    }
    let openConfirm = null;   // id of the booking whose "confirm" panel is open

    function fmtDate(iso) { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }
    function longDate(iso) {
        const [y, m, d] = iso.split("-").map(Number);
        const s = new Date(y, m - 1, d).toLocaleDateString(lang === "fr" ? "fr-CH" : "en-GB",
            { weekday: "long", day: "numeric", month: "long", year: "numeric" });
        return s.charAt(0).toUpperCase() + s.slice(1);
    }
    function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

    function clientWhatsApp(b, kind) {
        let n = String(b.customer.phone).replace(/[^\d+]/g, "");
        if (n.startsWith("+")) n = n.slice(1);
        else if (n.startsWith("00")) n = n.slice(2);
        else if (n.startsWith("0")) n = DEFAULT_COUNTRY_CODE + n.slice(1);
        const msgLang = clientMessages[b.lang] ? b.lang : "fr";
        return `https://wa.me/${n}?text=${encodeURIComponent(clientMessages[msgLang][kind](b))}`;
    }

    function renderFilters() {
        $("#filters").innerHTML = ["pending", "upcoming", "all"].map(f =>
            `<button type="button" class="chip" data-filter="${f}" aria-pressed="${f === filter}">${t(f)}</button>`).join("");
    }

    function badge(status) {
        if (status === "confirmed") return `<span class="badge badge--confirmed">${t("confirmed")}</span>`;
        if (status === "cancelled") return `<span class="badge badge--cancelled">${t("cancelled")}</span>`;
        return `<span class="badge">${t("waiting")}</span>`;
    }

    function payBadge(b) {
        if (b.status === "cancelled") return "";
        if (b.paymentStatus === "paid") return ` <span class="badge badge--confirmed">${t("paid")}${b.amount ? " · CHF " + money(b.amount) : ""}</span>`;
        if (b.status === "confirmed" && b.amount > 0) return ` <span class="badge">${t("unpaid")} · CHF ${money(b.amount)}</span>`;
        if (b.status === "confirmed") return ` <span class="badge badge--cancelled">${t("payInShop")}</span>`;
        return "";
    }

    function actions(b) {
        const id = esc(b.id);
        const out = [];
        if (b.status === "pending") {
            if (openConfirm === b.id) {
                return `
                <form class="confirm-panel" data-confirm-form="${id}">
                    <label for="amt-${id}">${t("amount")}</label>
                    <input id="amt-${id}" name="amount" type="number" inputmode="decimal" min="0" step="0.05" value="${esc(defaultPrice(b))}" ${paymentSettings.enabled ? "" : "disabled"}>
                    <small>${t("amountHint")}</small>
                    <button type="submit" class="btn btn--gold"><svg class="icon"><use href="#i-check"/></svg>${t("sendConfirm")}</button>
                    <button type="button" class="btn btn--ghost" data-act="close">${t("back")}</button>
                </form>`;
            }
            out.push(`<button type="button" class="btn btn--gold" data-act="open-confirm" data-id="${id}"><svg class="icon"><use href="#i-check"/></svg>${t("confirm")}</button>`);
        }
        if (b.status === "confirmed" && b.paymentStatus !== "paid") {
            if (payLink(b)) out.push(`<button type="button" class="btn btn--ghost" data-act="resend" data-id="${id}"><svg class="icon"><use href="#i-whatsapp"/></svg>${t("resend")}</button>`);
            out.push(`<button type="button" class="btn btn--ghost" data-act="mark-paid" data-id="${id}"><svg class="icon"><use href="#i-check"/></svg>${t("markPaid")}</button>`);
        }
        if (b.status !== "cancelled") out.push(`<button type="button" class="btn btn--ghost" data-act="cancelled" data-id="${id}"><svg class="icon"><use href="#i-close"/></svg>${t("cancel")}</button>`);
        out.push(`<a class="btn btn--ghost" href="${esc(clientWhatsApp(b, "message"))}" target="_blank" rel="noopener"><svg class="icon"><use href="#i-whatsapp"/></svg>${t("message")}</a>`);
        return out.join("");
    }

    function render() {
        document.documentElement.lang = lang;
        document.querySelectorAll("[data-t]").forEach(el => { el.textContent = t(el.dataset.t); });
        document.querySelectorAll(".lang__btn").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
        $("#demoNotice").hidden = BookingStore !== LocalStorageStore;
        renderFilters();

        const today = todayISO();
        const list = bookings.filter(b =>
            filter === "all" ? true :
            filter === "pending" ? b.status === "pending" && b.date >= today :
            b.status !== "cancelled" && b.date >= today);

        if (!list.length) { $("#list").innerHTML = `<p class="empty">${t("empty")}</p>`; return; }

        const groups = {};
        list.forEach(b => { (groups[b.date] = groups[b.date] || []).push(b); });

        $("#list").innerHTML = Object.keys(groups).sort().map(date => `
            <section class="day-group">
                <h2>${esc(longDate(date))}</h2>
                ${groups[date].map(b => `
                <article class="req${b.status === "cancelled" ? " is-cancelled" : ""}">
                    <div class="req__time">${esc(b.time)}<small>${esc(b.duration)} min</small></div>
                    <div class="req__who">
                        <strong>${esc(b.customer.name)}</strong>
                        <p>${esc(serviceName(b, lang))}</p>
                        <p>${esc(b.customer.phone)}${b.customer.email ? " · " + esc(b.customer.email) : ""}</p>
                        ${b.customer.notes ? `<p><em>${esc(b.customer.notes)}</em></p>` : ""}
                        <p class="req__badges">${esc(b.id)} &nbsp; ${badge(b.status)}${payBadge(b)}</p>
                    </div>
                    <div class="req__actions">${actions(b)}</div>
                </article>`).join("")}
            </section>`).join("");
    }

    // With Supabase, the admin must log in (Supabase Auth) to see the requests
    async function isLoggedIn() {
        if (BookingStore !== SupabaseStore) return true;
        const { data } = await SupabaseStore._client().auth.getSession();
        return !!data.session;
    }

    $("#login").addEventListener("submit", async e => {
        e.preventDefault();
        const { error } = await SupabaseStore._client().auth.signInWithPassword({
            email: $("#lEmail").value.trim(), password: $("#lPass").value
        });
        if (error) { $("#loginError").textContent = t("loginFailed"); return; }
        $("#login").hidden = true;
        load();
    });

    async function load() {
        if (!(await isLoggedIn())) { render(); $("#login").hidden = false; $("#list").innerHTML = ""; return; }
        try { bookings = await BookingStore.listBookings(); }
        catch (e) { console.error(e); bookings = []; alert(t("error")); }
        render();
    }

    document.addEventListener("click", async e => {
        const f = e.target.closest("[data-filter]");
        if (f) { filter = f.dataset.filter; render(); return; }
        const l = e.target.closest(".lang__btn");
        if (l) { lang = l.dataset.lang; render(); return; }

        const act = e.target.closest("[data-act]");
        if (!act) return;
        const kind = act.dataset.act;
        const b = bookings.find(x => x.id === act.dataset.id);

        if (kind === "open-confirm") { openConfirm = b.id; render(); focusAmount(); return; }
        if (kind === "close") { openConfirm = null; render(); return; }
        if (kind === "resend") { window.open(clientWhatsApp(b, "payment"), "_blank"); return; }
        if (kind === "mark-paid") {
            if (!confirm(t("askMarkPaid"))) return;
            return save(() => BookingStore.updateStatus(b.id, b.status, { paymentStatus: "paid" }));
        }
        if (kind === "cancelled") {
            if (!confirm(b.paymentStatus === "paid" ? t("askCancelPaid") : t("askCancel"))) return;
            const win = window.open(clientWhatsApp(b, "cancelled"), "_blank");
            return save(() => BookingStore.updateStatus(b.id, "cancelled"), win);
        }
    });

    // "Confirm and send": save the amount, then WhatsApp the confirmation + payment link
    document.addEventListener("submit", e => {
        const form = e.target.closest("[data-confirm-form]");
        if (!form) return;
        e.preventDefault();
        const b = bookings.find(x => x.id === form.dataset.confirmForm);
        const raw = String(form.amount.value).replace(",", ".").trim();
        const amount = paymentSettings.enabled && Number(raw) > 0 ? Math.round(Number(raw) * 100) / 100 : null;

        const confirmedBooking = { ...b, status: "confirmed", amount };
        // WhatsApp must open immediately after the click (pop-up blockers)
        const win = window.open(clientWhatsApp(confirmedBooking, "confirmed"), "_blank");
        openConfirm = null;
        save(() => BookingStore.updateStatus(b.id, "confirmed", { amount }), win);
    });

    async function save(action, win) {
        try { await action(); await load(); }
        catch (err) { console.error(err); if (win) win.close(); alert(t("error")); }
    }

    function focusAmount() {
        const input = document.querySelector(".confirm-panel input");
        if (input) { input.focus(); input.select(); }
    }

    load();
})();
