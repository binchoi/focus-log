"use client";

import { useEffect, useState } from "react";
import { fetchSummary } from "../../utils/googleSheetsApi";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const [goals, setGoals] = useState([]);
  const [activeGoalId, setActiveGoalId] = useState(null);
  const router = useRouter();

  useEffect(() => {
    // Check for credentials
    const credentials = JSON.parse(localStorage.getItem("credentials"));
    if (!credentials) {
      router.push("/credentials");
      return;
    }

    // Fetch goals summary
    fetchSummary(credentials)
      .then((data) => setGoals(data))
      .catch((err) => console.error(err));

    // Check for an active timer in local storage
    const activeTimer = JSON.parse(localStorage.getItem("active_timer"));
    if (activeTimer) {
      setActiveGoalId(activeTimer.goalId); // Store the active goal ID
    }
  }, []);

  return (
    <div className="homepage-container">
      <header>
        <h1 className="app-title">Focus Log</h1>
      </header>
      <div className="goals-grid">
        {goals.map(({ g_id, title, total_duration }) => {
          const hours = Math.floor(total_duration / 60);
          const minutes = total_duration % 60;

          // Determine if the current goal is active
          const isActive = g_id === activeGoalId;

          return (
            <div
              key={g_id}
              className={`goal-card ${isActive ? "active-goal" : ""}`}
            >
              <Link href={`/goal/${g_id}`}>
                <div className="goal-content">
                  <h2>{title}</h2>
                  <p>{hours}h {minutes}m</p>
                </div>
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
