// Console sign-in. Same salted SHA-256 scheme as the Python edition (auth.py).
// NOTE: on a static site this is an access gate for the demo, not real security -
// a production NMS must authenticate on a server.

const SALT = "nms-22CSPW0";
const USERS = {
  admin: { hash: "dc41b453e618b29dab8c72a56db32dd4f924340bc6dada2a7f143999fe017b85",
           name: "NMS Administrator", role: "Network Administrator" },
};
const MAX_ATTEMPTS = 5, LOCK_MS = 30000;
const KEY = "netguard.session", LOCK = "netguard.lock";

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const store = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

export function currentUser() { return store.get(KEY); }
export function logout() { store.del(KEY); }

/** Returns {ok, user} or {ok:false, error}. */
export async function login(username, password) {
  const lock = store.get(LOCK) || { attempts: 0, until: 0 };
  if (Date.now() < lock.until) {
    return { ok: false, error: `Too many failed attempts. Try again in ${Math.ceil((lock.until - Date.now()) / 1000)} s.` };
  }
  const name = username.trim().toLowerCase();
  const user = USERS[name];
  if (user && (await sha256(`${SALT}:${password}`)) === user.hash) {
    const session = { username: name, name: user.name, role: user.role, since: new Date().toISOString() };
    store.set(KEY, session); store.del(LOCK);
    return { ok: true, user: session };
  }
  lock.attempts += 1;
  if (lock.attempts >= MAX_ATTEMPTS) {
    store.set(LOCK, { attempts: 0, until: Date.now() + LOCK_MS });
    return { ok: false, error: "Account locked for 30 seconds." };
  }
  store.set(LOCK, lock);
  return { ok: false, error: `Invalid username or password. ${MAX_ATTEMPTS - lock.attempts} attempt(s) left.` };
}
