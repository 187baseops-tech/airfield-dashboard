import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Dashboard from "./Dashboard";
import KioskDashboard from "./KioskDashboard";

export default function App() {
  return (
    <Router basename="/">
      <Routes>
        {/* Full interactive dashboard */}
        <Route path="/" element={<Dashboard />} />

        {/* Read-only kiosk dashboard */}
        <Route path="/kiosk" element={<KioskDashboard />} />

        {/* Optional: catch-all route (fallback to dashboard) */}
        <Route path="*" element={<Dashboard />} />
      </Routes>
    </Router>
  );
}
