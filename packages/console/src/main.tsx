// SPDX-License-Identifier: MIT
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Console } from "@/components/console";
import { SignIn } from "@/components/sign-in";
import { startSession, useSession } from "@/lib/session";
import "./globals.css";

/** The console once a session is signed in; the sign-in page until then. */
function App() {
  const session = useSession();
  return session.status === "signed-in" ? (
    <Console />
  ) : (
    <SignIn state={session} />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
void startSession();
// A link pasted into this tab while it shows `/` changes only the fragment,
// which does not reload the page.
window.addEventListener("hashchange", () => {
  if (window.location.hash.startsWith("#login=")) void startSession();
});
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
