import { BrowserRouter, Routes, Route } from "react-router-dom";
import Dashboard from "./Dashboard";
import KioskDashboard from "./KioskDashboard";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Main dashboard */}
        <Route path="/" element={<Dashboard />} />

        {/* Kiosk dashboard (read-only) */}
        <Route path="/kiosk" element={<KioskDashboard />} />

        {/* Catch-all for invalid routes */}
        <Route path="*" element={<div className="text-center text-white p-4">404 Not Found</div>} />
      </Routes>
    </BrowserRouter>
  );
}
