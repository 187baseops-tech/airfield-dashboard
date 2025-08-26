import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Dashboard from "./Dashboard";
import KioskDashboard from "./KioskDashboard";

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/kiosk" element={<KioskDashboard />} />
      </Routes>
    </Router>
  );
}
