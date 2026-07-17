// Sign-in page for the admin control center. Loads the public Supabase config
// from the BFF, exchanges email + password for a session directly against
// Supabase Auth, stores the tokens under the keys the admin app reads
// (rr_admin_token / rr_admin_refresh), and redirects to /admin/.

const TOKEN_KEY = "rr_admin_token";
const REFRESH_KEY = "rr_admin_refresh";
const CONFIG_URL = "/api/admin/v1/config";

function storeSession(accessToken, refreshToken) {
  try {
    localStorage.setItem(TOKEN_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
    else localStorage.removeItem(REFRESH_KEY);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig() {
  let response;
  try {
    response = await fetch(CONFIG_URL, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  if (!response.ok) {
    throw new Error("Sign-in is not available: the server is missing its Supabase configuration.");
  }
  const config = await response.json().catch(() => null);
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) {
    throw new Error("Sign-in is not available: the server returned an incomplete configuration.");
  }
  return config;
}

async function signIn(email, password) {
  const config = await loadConfig();
  let response;
  try {
    response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseAnonKey
      },
      body: JSON.stringify({ email, password })
    });
  } catch {
    throw new Error("Could not reach the authentication service. Please try again.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    const message =
      data?.error_description ||
      data?.msg ||
      (response.status === 400 ? "Invalid email or password." : null) ||
      `Sign-in failed (status ${response.status}).`;
    throw new Error(message);
  }
  if (!storeSession(data.access_token, data.refresh_token ?? "")) {
    throw new Error("Signed in, but this browser blocked local storage. Enable it and retry.");
  }
}

function wireForm() {
  const form = document.getElementById("login-form");
  const emailInput = document.getElementById("login-email");
  const passwordInput = document.getElementById("login-password");
  const submitButton = document.getElementById("login-submit");
  const errorBox = document.getElementById("login-error");
  const status = document.getElementById("login-status");
  if (!form || !emailInput || !passwordInput || !submitButton) return;

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (errorBox) errorBox.hidden = true;
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      showError("Enter both your email and password.");
      return;
    }
    submitButton.disabled = true;
    if (status) status.textContent = "Signing in...";
    try {
      await signIn(email, password);
      if (status) status.textContent = "Signed in. Redirecting...";
      window.location.href = "/admin/";
    } catch (error) {
      if (status) status.textContent = "";
      showError(error.message);
      submitButton.disabled = false;
    }
  });
}

wireForm();
