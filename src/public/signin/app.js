import { chooseDestination, isSafeNextPath } from "./destination.js";

const TOKEN_KEY = "rr_admin_token";

const form = document.getElementById("signin-form");
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const signinButton = document.getElementById("signin-button");
const errorMessage = document.getElementById("error-message");

// S-11: the refresh token no longer travels in the response body -- the
// server sets it as an HttpOnly `rr_refresh` cookie instead, so only the
// access token is ever stored here (client JS cannot read it either way).
function storeSession(session) {
  try {
    localStorage.setItem(TOKEN_KEY, session.access_token);
  } catch {
    // Storage may be unavailable (private browsing, blocked cookies). The
    // redirect below will bounce straight back here, and the message shown
    // then is more useful than silently looping.
  }
}

// Where to land after a successful sign-in. A valid same-origin `?next=` wins
// without a network round trip (chooseDestination would return it anyway);
// otherwise /me is fetched with the fresh access token so chooseDestination
// can weigh the user's actual permissions: anyone holding an operational
// permission lands on the ops app, a pure admin on the admin console. A
// failed /me lookup is passed through as null and falls back to "/".
async function resolveDestination(accessToken) {
  const nextParam = new URLSearchParams(window.location.search).get("next");
  if (isSafeNextPath(nextParam)) return nextParam;

  let meResponse = null;
  try {
    const response = await fetch("/api/v1/me", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (response.ok) {
      meResponse = await response.json();
    }
  } catch {
    // Network error reaching /me -- chooseDestination falls back to "/".
  }

  return chooseDestination(nextParam, meResponse);
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
      credentials: "same-origin",
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
      window.location.assign(await resolveDestination(data.access_token));
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
