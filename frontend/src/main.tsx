import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { isValidRoomCode } from "./components/CodeInput";
import { Landing } from "./pages/Landing";
import { RoomPage } from "./pages/RoomPage";
import "./styles/global.css";
import "./styles/landing.css";
import "./styles/room.css";

/** A join link, /j/CODE: opens the front page on "Join with a code" with the code filled in. */
function JoinLink() {
  const code = (useParams().code ?? "").toUpperCase();
  const state = isValidRoomCode(code)
    ? { mode: "join", code, hint: "Here's the room's code. Add your name to come in." }
    : { mode: "join", hint: "That link's code doesn't look right. Type the code you were given." };
  return <Navigate to="/" replace state={state} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/room/:roomId" element={<RoomPage />} />
        <Route path="/j/:code" element={<JoinLink />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
