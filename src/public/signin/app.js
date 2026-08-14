const TOKEN_KEY = "rr_admin_token";
const REFRESH_TOKEN_KEY = "rr_refresh_token";
const DEFAULT_DESTINATION = "/admin/";

const form = document.getElementById("signin-form");
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const signinButton = document.getElementById("signin-button");
const errorMessage = document.getElementById("error-message");

// Where to land after a successful sign-in. Only same-origin, path-only values
// are honoured: `next` comes from the query string, so an absolute URL there
// would turn this page into an open redirect.
function destination() {
  const requested = new URLSearchParams(window.location.search).get("next");
  if (!requested) return DEFAULT_DESTINATION;
  if (!requested.startsWith("/") || requested.startsWith("//")) return DEFAULT_DESTINATION;
  return requested;
}

function storeSession(session) {
  try {
    localStorage.setItem(TOKEN_KEY, session.access_token);
    if (session.refresh_token) {
      localStorage.setItem(REFRESH_TOKEN_KEY, session.refresh_token);
    }
  } catch {
    // Storage may be unavailable (private browsing, blocked cookies). The
    // redirect below will bounce straight back here, and the message shown
    // then is more useful than silently looping.
  }
}

form.addEventListener("submit", handleSignIn);

async function handleSignIn(event) {
  event.preventDefault();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showError("Please enter your email and password.");
    return;
  }

  signinButton.disabled = true;
  signinButton.textContent = "Signing in…";
  clearError();

  try {
    const response = await fetch("/api/v1/auth/sign-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });

    if (response.status === 200) {
      const data = await response.json();

      if (!data.access_token) {
        failWith("Invalid sign-in response from server. Please try again.");
        return;
      }

      storeSession(data);
      window.location.assign(destination());
    } else if (response.status === 401) {
      failWith("Invalid email or password.");
    } else if (response.status === 503) {
      failWith("Sign-in is not configured on this server. Contact your administrator.");
    } else {
      failWith("Sign-in failed. Please try again.");
    }
  } catch {
    failWith("Network error. Please check your connection and try again.");
  }
}

function failWith(message) {
  showError(message);
  signinButton.disabled = false;
  signinButton.textContent = "Sign In";
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.removeAttribute("hidden");
}

function clearError() {
  errorMessage.textContent = "";
  errorMessage.setAttribute("hidden", "");
}
