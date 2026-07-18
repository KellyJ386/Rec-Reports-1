const TOKEN_KEY = "rr_admin_token";
const REFRESH_TOKEN_KEY = "rr_refresh_token";

const form = document.getElementById("signin-form");
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const signinButton = document.getElementById("signin-button");
const errorMessage = document.getElementById("error-message");

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
      const accessToken = data.access_token;
      const refreshToken = data.refresh_token;

      if (!accessToken) {
        showError("Invalid sign-in response from server. Please try again.");
        signinButton.disabled = false;
        return;
      }

      try {
        localStorage.setItem(TOKEN_KEY, accessToken);
        if (refreshToken) {
          localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
        }
      } catch {
        // Storage may be unavailable; redirect anyway and hope the token
        // persists via session storage or that the app handles missing storage gracefully.
      }

      window.location.href = "/admin/";
    } else if (response.status === 401) {
      showError("Invalid email or password.");
      signinButton.disabled = false;
    } else {
      showError("Sign-in failed. Please try again.");
      signinButton.disabled = false;
    }
  } catch (error) {
    showError("Network error. Please check your connection and try again.");
    signinButton.disabled = false;
  }
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.removeAttribute("hidden");
}

function clearError() {
  errorMessage.textContent = "";
  errorMessage.setAttribute("hidden", "");
}
