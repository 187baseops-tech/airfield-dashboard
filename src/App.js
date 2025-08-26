import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Dashboard from "./Dashboard";
import KioskDashboard from "./KioskDashboard";

export default function App() {
  return (
    <Router basename="/">
      <Routes>
        {/* Explicit kiosk route */}
        <Route path="/kiosk" element={<KioskDashboard />} />

        {/* Main dashboard */}
        <Route path="/" element={<Dashboard />} />

        {/* Catch-all fallback */}
        <Route path="*" element={<Dashboard />} />
      </Routes>
    </Router>
  );
}
