/* ==========================================================================
   BOOKING STORAGE
   --------------------------------------------------------------------------
   The rest of the website only talks to `BookingStore` below, through
   these 4 functions:

       BookingStore.getBusySlots(barberId, date)  → [{ time, duration }]
       BookingStore.createBooking(booking)        → saved booking (or throws SLOT_TAKEN)
       BookingStore.listBookings()                → all bookings   (admin page)
       BookingStore.updateStatus(id, status, extra) → update a booking (admin page)
                                                    extra = { amount, paymentStatus }
       BookingStore.getPaymentInfo(token)         → booking summary for pay.html
       BookingStore.startPayment(token)           → { url } of the Stripe payment page

   ⚠ DEMO MODE (active by default): bookings are saved in the visitor's
   browser (localStorage). They survive a page refresh, but they are NOT
   shared between different customers or devices.

   ✅ PRODUCTION: fill in SUPABASE_URL and SUPABASE_ANON_KEY below
   (see README.md). The website then switches to the database automatically:
   every customer sees the same availability and double bookings are
   blocked by the database.
   ========================================================================== */

const STORAGE_KEY = "rapi-coiffure-bookings-v1";

/* Helpers shared by every store ------------------------------------------ */
const BookingUtils = {
    toMinutes(hhmm) {
        const [h, m] = hhmm.split(":").map(Number);
        return h * 60 + m;
    },
    // Do two appointments overlap? (start in "HH:MM", duration in minutes)
    overlaps(startA, durA, startB, durB) {
        const a = this.toMinutes(startA), b = this.toMinutes(startB);
        return a < b + durB && b < a + durA;
    },
    // Secret, unguessable id used in the payment link (pay.html?t=...)
    makeToken() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
        });
    },
    // Short, readable reference such as "RC-4K7Q2"
    makeReference() {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let ref = "";
        for (let i = 0; i < 5; i++) ref += chars[Math.floor(Math.random() * chars.length)];
        return "RC-" + ref;
    }
};

class SlotTakenError extends Error {
    constructor() { super("SLOT_TAKEN"); this.code = "SLOT_TAKEN"; }
}
class PaymentError extends Error {
    // code: NOT_FOUND | NOT_CONFIRMED | ALREADY_PAID | NO_AMOUNT | SERVER
    constructor(code) { super(code); this.code = code; }
}

// What pay.html needs to know (no personal data)
function paymentInfoFrom(b) {
    return {
        reference: b.id, barberId: b.barberId, serviceId: b.serviceId, date: b.date, time: b.time,
        duration: b.duration, amount: b.amount, status: b.status,
        paymentStatus: b.paymentStatus || "unpaid", lang: b.lang
    };
}


/* ==========================================================================
   A) DEMO STORE — localStorage (works without any server)
   ========================================================================== */
const LocalStorageStore = {
    _read() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
        catch (e) { return []; }
    },
    _write(list) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    },

    async getBusySlots(barberId, date) {
        return this._read()
            .filter(b => b.barberId === barberId && b.date === date && b.status !== "cancelled")
            .map(b => ({ time: b.time, duration: b.duration }));
    },

    async createBooking(data) {
        const list = this._read();
        // Final double-booking check, right before saving.
        const clash = list.some(b =>
            b.barberId === data.barberId &&
            b.date === data.date &&
            b.status !== "cancelled" &&
            BookingUtils.overlaps(b.time, b.duration, data.time, data.duration)
        );
        if (clash) throw new SlotTakenError();

        const booking = {
            ...data,
            id: BookingUtils.makeReference(),
            status: "pending",               // pending → confirmed / cancelled by the admin
            payToken: BookingUtils.makeToken(),
            amount: null,                    // set by the admin when confirming
            paymentStatus: "unpaid",         // unpaid → paid
            createdAt: new Date().toISOString()
        };
        list.push(booking);
        this._write(list);
        return booking;
    },

    async listBookings() {
        return this._read().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    },

    async updateStatus(id, status, extra = {}) {
        const list = this._read();
        const booking = list.find(b => b.id === id);
        if (!booking) throw new Error("NOT_FOUND");
        booking.status = status;
        if (extra.amount !== undefined) booking.amount = extra.amount;
        if (extra.paymentStatus !== undefined) booking.paymentStatus = extra.paymentStatus;
        this._write(list);
        return booking;
    },

    async getPaymentInfo(token) {
        const b = this._read().find(x => x.payToken === token);
        return b ? paymentInfoFrom(b) : null;
    },

    // DEMO ONLY: no real payment — the booking is simply marked as paid.
    async startPayment(token) {
        const list = this._read();
        const b = list.find(x => x.payToken === token);
        if (!b) throw new PaymentError("NOT_FOUND");
        if (b.paymentStatus === "paid") throw new PaymentError("ALREADY_PAID");
        if (b.status !== "confirmed") throw new PaymentError("NOT_CONFIRMED");
        if (!(b.amount > 0)) throw new PaymentError("NO_AMOUNT");
        b.paymentStatus = "paid";
        this._write(list);
        return { demo: true };
    },

    // Refresh the time slots when another tab books something.
    onChange(callback) {
        window.addEventListener("storage", e => { if (e.key === STORAGE_KEY) callback(); });
    }
};


/* ==========================================================================
   B) PRODUCTION STORE — Supabase (free tier is enough for a barbershop)
   --------------------------------------------------------------------------
   1. Create a project at https://supabase.com
   2. Run  backend/supabase-schema.sql  in Supabase → SQL Editor
   3. Fill in SUPABASE_URL and SUPABASE_ANON_KEY below — that's all.
   ========================================================================== */
const SUPABASE_URL = "https://qwjcnjajairmsheuqicu.supabase.co";          // e.g. "https://abcdefgh.supabase.co"
const SUPABASE_ANON_KEY = "sb_publishable_Ji3iMKU6y-G2TQd1k1lrvg_wYGmIVhX";     // Project Settings → API → "anon public" (or "publishable") key

const SupabaseStore = {
    _client() {
        if (!this.__c) this.__c = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        return this.__c;
    },

    async getBusySlots(barberId, date) {
        // Only times are returned — never other customers' names or phones.
        const { data, error } = await this._client()
            .rpc("get_busy_slots", { p_barber: barberId, p_date: date });
        if (error) throw error;
        return data.map(r => ({ time: r.start_time.slice(0, 5), duration: r.duration_min }));
    },

    async createBooking(d) {
        const reference = BookingUtils.makeReference();
        const { error } = await this._client().rpc("request_booking", {
            p_reference: reference,
            p_barber: d.barberId,
            p_service: d.serviceId,
            p_date: d.date,
            p_time: d.time,
            p_duration: d.duration,
            p_name: d.customer.name,
            p_phone: d.customer.phone,
            p_email: d.customer.email || null,
            p_notes: d.customer.notes || null,
            p_lang: d.lang
        });
        if (error) {
            if (String(error.message).includes("SLOT_TAKEN")) throw new SlotTakenError();
            throw error;
        }
        return { ...d, id: reference, status: "pending", createdAt: new Date().toISOString() };
    },

    // The admin functions need a logged-in admin (Supabase Auth). See README.
    async listBookings() {
        const { data, error } = await this._client()
            .from("bookings").select("*").order("booking_date").order("start_time");
        if (error) throw error;
        return data.map(r => ({
            id: r.reference, barberId: r.barber_id, serviceId: r.service_id,
            date: r.booking_date, time: r.start_time.slice(0, 5), duration: r.duration_min,
            status: r.status, lang: r.lang, createdAt: r.created_at,
            payToken: r.pay_token, amount: r.amount_chf == null ? null : Number(r.amount_chf),
            paymentStatus: r.payment_status,
            customer: { name: r.customer_name, phone: r.customer_phone, email: r.customer_email, notes: r.notes }
        }));
    },

    async updateStatus(id, status, extra = {}) {
        const changes = { status };
        if (extra.amount !== undefined) changes.amount_chf = extra.amount;
        if (extra.paymentStatus !== undefined) {
            changes.payment_status = extra.paymentStatus;
            if (extra.paymentStatus === "paid") changes.paid_at = new Date().toISOString();
        }
        const { error } = await this._client()
            .from("bookings").update(changes).eq("reference", id);
        if (error) throw error;
        return { id, status };
    },

    async getPaymentInfo(token) {
        const { data, error } = await this._client().rpc("get_payment_info", { p_token: token });
        if (error) throw error;
        const r = data && data[0];
        if (!r) return null;
        return {
            reference: r.reference, barberId: r.barber_id, serviceId: r.service_id,
            date: r.booking_date, time: r.start_time.slice(0, 5), duration: r.duration_min,
            amount: r.amount_chf == null ? null : Number(r.amount_chf),
            status: r.status, paymentStatus: r.payment_status, lang: r.lang
        };
    },

    // Asks the server (Supabase Edge Function "create-checkout") for a Stripe payment page.
    async startPayment(token) {
        const { data, error } = await this._client().functions.invoke("create-checkout", { body: { token } });
        if (error) {
            let code = "SERVER";
            try { code = (await error.context.json()).error || code; } catch (e) { /* ignore */ }
            throw new PaymentError(code);
        }
        return { url: data.url };
    },

    onChange(callback) {
        // Customers can't read the bookings table directly (privacy), so the
        // availability is simply refreshed every 30 s and when the tab regains focus.
        setInterval(callback, 30000);
        window.addEventListener("focus", callback);
    }
};


/* ==========================================================================
   ▶ ACTIVE STORE — the database is used as soon as both values above are filled
   ========================================================================== */
const BookingStore = (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase) ? SupabaseStore : LocalStorageStore;
