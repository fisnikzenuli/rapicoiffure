/* ==========================================================================
   RAPI COIFFURE — PAYMENT PAGE (pay.html?t=...)
   Opened from the payment link in the confirmation WhatsApp.
   Shows the appointment and sends the client to Stripe's secure payment page
   (TWINT, cards, Apple Pay, Google Pay). After paying, Stripe brings the client
   back here with &paid=1 and the page waits until the payment is registered.
   ========================================================================== */
(function () {
    "use strict";

    const texts = {
        fr: {
            title: "Régler votre rendez-vous",
            loading: "Chargement…",
            service: "Service", date: "Date", time: "Heure", total: "À payer", totalPaid: "Montant payé", ref: "Référence",
            pay: "Payer CHF {amount}",
            redirecting: "Redirection vers le paiement sécurisé…",
            secure: "Paiement sécurisé par Stripe. Rapi Coiffure ne voit jamais vos données bancaires.",
            paidTitle: "Paiement reçu. Merci !",
            paidText: "Votre rendez-vous est confirmé et payé. À bientôt chez Rapi Coiffure.",
            checking: "Nous vérifions votre paiement… cela prend quelques secondes.",
            checkingSlow: "Votre paiement est en cours de traitement. Si vous avez payé, vous n'avez rien d'autre à faire : nous le verrons de notre côté.",
            notFound: "Ce lien de paiement n'est pas valide. Vérifiez le lien reçu sur WhatsApp ou contactez-nous.",
            notConfirmed: "Ce rendez-vous n'est pas encore confirmé. Vous recevrez le lien de paiement avec la confirmation.",
            cancelled: "Ce rendez-vous a été annulé. Contactez-nous pour en fixer un autre.",
            noAmount: "Ce rendez-vous se règle directement au salon.",
            error: "Le paiement n'a pas pu démarrer. Réessayez dans un instant ou contactez-nous sur WhatsApp.",
            contact: "Nous contacter sur WhatsApp",
            home: "Retour au site",
            demo: "Mode démo : aucun paiement réel. Le bouton marque simplement le rendez-vous comme payé.",
            legal: "Mentions légales :"
        },
        en: {
            title: "Pay for your appointment",
            loading: "Loading…",
            service: "Service", date: "Date", time: "Time", total: "To pay", totalPaid: "Amount paid", ref: "Reference",
            pay: "Pay CHF {amount}",
            redirecting: "Taking you to the secure payment page…",
            secure: "Secure payment by Stripe. Rapi Coiffure never sees your card or bank details.",
            paidTitle: "Payment received. Thank you!",
            paidText: "Your appointment is confirmed and paid. See you soon at Rapi Coiffure.",
            checking: "We're checking your payment… this takes a few seconds.",
            checkingSlow: "Your payment is being processed. If you paid, there's nothing else to do: we'll see it on our side.",
            notFound: "This payment link isn't valid. Check the link you received on WhatsApp or contact us.",
            notConfirmed: "This appointment isn't confirmed yet. You'll receive the payment link with the confirmation.",
            cancelled: "This appointment was cancelled. Contact us to book another one.",
            noAmount: "This appointment is paid directly at the shop.",
            error: "The payment couldn't start. Try again in a moment or contact us on WhatsApp.",
            contact: "Contact us on WhatsApp",
            home: "Back to the website",
            demo: "Demo mode: no real payment. The button simply marks the appointment as paid.",
            legal: "Legal notice:"
        }
    };

    const params = new URLSearchParams(location.search);
    const token = params.get("t") || "";
    const returnedFromStripe = params.get("paid") === "1";

    let lang = "fr";
    try { lang = localStorage.getItem("rapi-coiffure-lang") || "fr"; } catch (e) { /* ignore */ }
    let info = null;
    let view = "loading";         // loading | payable | paid | checking | checkingSlow | notFound | notConfirmed | cancelled | noAmount
    let errorMsg = "";
    let busy = false;

    const $ = s => document.querySelector(s);
    const t = (k, vars) => {
        let s = (texts[lang] || texts.fr)[k];
        if (vars) Object.keys(vars).forEach(v => { s = s.split("{" + v + "}").join(vars[v]); });
        return s;
    };
    const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const money = n => Number(n).toFixed(2).replace(/\.00$/, "");
    const waLink = () => `https://wa.me/${String(businessSettings.whatsappNumber).replace(/\D/g, "")}`;

    function longDate(iso) {
        const [y, m, d] = iso.split("-").map(Number);
        const s = new Date(y, m - 1, d).toLocaleDateString(lang === "fr" ? "fr-CH" : "en-GB",
            { weekday: "long", day: "numeric", month: "long", year: "numeric" });
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function summary() {
        const service = services.find(s => s.id === info.serviceId);
        const row = (label, value, big) =>
            `<div class="summary__row${big ? " summary__row--big" : ""}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
        return `<div class="summary"><dl>
            ${row(t("service"), service ? (service.name[lang] || service.name.fr) : "—")}
            ${row(t("date"), longDate(info.date))}
            ${row(t("time"), info.time)}
            ${row(t("ref"), info.reference)}
            ${info.amount > 0 ? `<hr class="summary__rule">${row(t(info.paymentStatus === "paid" ? "totalPaid" : "total"), "CHF " + money(info.amount), true)}` : ""}
        </dl></div>`;
    }

    const contactButtons = () => `
        <div class="pay__center">
            <a class="btn btn--gold" href="${waLink()}" target="_blank" rel="noopener"><svg class="icon"><use href="#i-whatsapp"/></svg>${t("contact")}</a>
        </div>`;

    function render() {
        document.documentElement.lang = lang;
        document.querySelectorAll(".lang__btn").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
        $("#payTitle").textContent = view === "paid" ? t("paidTitle") : t("title");
        $("#payLegal").textContent = typeof legalInfo !== "undefined"
            ? `${t("legal")} ${legalInfo.company} · ${legalInfo.address}` : "";

        let html = "";
        switch (view) {
            case "loading":
                html = `<p class="pay__msg">${t("loading")}</p>`; break;
            case "notFound":
                html = `<p class="pay__msg">${t("notFound")}</p>${contactButtons()}`; break;
            case "notConfirmed":
            case "cancelled":
            case "noAmount":
                html = `${summary()}<p class="notice">${t(view)}</p>${contactButtons()}`; break;
            case "checking":
            case "checkingSlow":
                html = `${summary()}<p class="notice">${t(view)}</p>`; break;
            case "paid":
                html = `
                    <div class="success__seal"><svg class="icon"><use href="#i-check"/></svg></div>
                    <p class="pay__msg">${t("paidText")}</p>
                    ${summary()}
                    <div class="pay__center"><a class="btn btn--ghost" href="index.html">${t("home")}</a></div>`;
                break;
            case "payable":
                html = `
                    ${summary()}
                    ${BookingStore === LocalStorageStore ? `<p class="notice">${t("demo")}</p>` : ""}
                    ${errorMsg ? `<p class="alert" role="alert">${esc(errorMsg)}</p>` : ""}
                    <button type="button" class="btn btn--gold btn--lg pay__btn" id="payBtn" ${busy ? "disabled" : ""}>
                        <svg class="icon"><use href="#i-lock"/></svg>${busy ? t("redirecting") : t("pay", { amount: money(info.amount) })}
                    </button>
                    <p class="pay__methods">${esc(paymentSettings.methods)}</p>
                    <p class="pay__secure">${t("secure")}</p>`;
                break;
        }
        $("#payContent").innerHTML = html;
    }

    function viewFor(i) {
        if (!i) return "notFound";
        if (i.paymentStatus === "paid") return "paid";
        if (i.status === "cancelled") return "cancelled";
        if (i.status !== "confirmed") return "notConfirmed";
        if (!(i.amount > 0) || !paymentSettings.enabled) return "noAmount";
        return "payable";
    }

    async function fetchInfo() {
        try { info = token ? await BookingStore.getPaymentInfo(token) : null; }
        catch (e) { console.error(e); info = null; }
        return info;
    }

    // After Stripe: wait for the webhook to mark the booking as paid
    async function waitForPayment() {
        view = "checking"; render();
        for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 2500));
            await fetchInfo();
            if (info && info.paymentStatus === "paid") { view = "paid"; render(); return; }
        }
        view = "checkingSlow"; render();
    }

    async function startPayment() {
        if (busy) return;
        busy = true; errorMsg = ""; render();
        try {
            const res = await BookingStore.startPayment(token);
            if (res.url) { location.href = res.url; return; }   // → Stripe
            await fetchInfo();                                   // demo mode
            view = viewFor(info);
        } catch (e) {
            console.error(e);
            if (e.code === "ALREADY_PAID") { await fetchInfo(); view = viewFor(info); }
            else if (["NOT_CONFIRMED", "NO_AMOUNT", "NOT_FOUND"].includes(e.code)) { await fetchInfo(); view = viewFor(info); }
            else errorMsg = t("error");
        }
        busy = false; render();
    }

    document.addEventListener("click", e => {
        const l = e.target.closest(".lang__btn");
        if (l) { lang = l.dataset.lang; try { localStorage.setItem("rapi-coiffure-lang", lang); } catch (err) { /* ignore */ } render(); return; }
        if (e.target.closest("#payBtn")) startPayment();
    });

    (async function init() {
        render();
        await fetchInfo();
        let saved = null;
        try { saved = localStorage.getItem("rapi-coiffure-lang"); } catch (e) { /* ignore */ }
        if (info && info.lang && texts[info.lang] && !saved) lang = info.lang;   // the language they booked in
        view = viewFor(info);
        if (returnedFromStripe && view === "payable") return waitForPayment();
        render();
    })();
})();
