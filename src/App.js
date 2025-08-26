import { HashRouter, Routes, Route } from "react-router-dom";
import Dashboard from "./Dashboard";
import KioskDashboard from "./KioskDashboard";

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/kiosk" element={<KioskDashboard />} />
        <Route path="*" element={<div className="text-center text-white p-4">404 Not Found</div>} />
      </Routes>
    </HashRouter>
  );
}
