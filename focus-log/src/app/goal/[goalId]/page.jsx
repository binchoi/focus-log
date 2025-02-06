"use client";

import React, { useEffect, useState } from "react";
import { appendLog, getTitleByGid } from "../../../../utils/googleSheetsApi";
import { useRouter } from "next/navigation";

import Navbar from "../../../../components/Navbar";


export default function GoalPage({ params }) {
  const router = useRouter();
  const { goalId } = React.use(params);

  const [timer, setTimer] = useState(null);
  const [focusTime, setFocusTime] = useState(0);
  const [title, setTitle] = useState("");
  const [isAnotherTimerActive, setIsAnotherTimerActive] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [adjustedFocusTimeMinutes, setAdjustedFocusTimeMinutes] = useState(0); // Store adjusted time in minutes
  const [tooltipVisible, setTooltipVisible] = useState(false); // Tooltip visibility

  const TIMER_KEY = `goal_timer_${goalId}`;
  const ACTIVE_TIMER_KEY = "active_timer";
  const TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

  // Load goal title and check for ongoing timer
  useEffect(() => {
    const cachedTitle = getTitleByGid(goalId);
    if (cachedTitle === "Unknown Goal") {
      console.warn(`Goal ID ${goalId} not found in cache`);
    }
    setTitle(cachedTitle);

    // Check for ongoing timer for this goal
    const storedTimer = JSON.parse(localStorage.getItem(TIMER_KEY));
    if (storedTimer) {
      const { startTime, timestamp } = storedTimer;

      // Validate TTL
      if (Date.now() - timestamp < TTL) {
        const elapsedTime = Math.floor((Date.now() - new Date(startTime)) / 1000);
        setFocusTime(elapsedTime);
        resumeTimer(elapsedTime); // Resume timer
      } else {
        localStorage.removeItem(TIMER_KEY); // Clear expired data
      }
    }

    // Check if another task's timer is active
    const activeTimer = JSON.parse(localStorage.getItem(ACTIVE_TIMER_KEY));
    if (activeTimer && activeTimer.goalId !== goalId) {
      setIsAnotherTimerActive(true);
    }
  }, [goalId]);

  // Start Timer
  const startTimer = () => {
    if (timer || isAnotherTimerActive) return;

    const startTime = new Date();
    localStorage.setItem(
      TIMER_KEY,
      JSON.stringify({ startTime: startTime.toISOString(), timestamp: Date.now() })
    );
    localStorage.setItem(
      ACTIVE_TIMER_KEY,
      JSON.stringify({ goalId, startTime: startTime.toISOString() })
    );

    resumeTimer(0); // Start fresh
  };

  // Resume Timer Helper
  const resumeTimer = (elapsed) => {
    setTimer(
      setInterval(() => {
        setFocusTime((prev) => prev + 1);
      }, 1000)
    );
    setFocusTime(elapsed);
  };

  // Stop Timer
  const stopTimer = () => {
    if (!timer) return;

    clearInterval(timer);
    setTimer(null);

    // Open the modal and allow user to confirm or adjust the session
    setIsModalOpen(true);
    setAdjustedFocusTimeMinutes(Math.floor(focusTime / 60)); // Initialize adjusted time in minutes
  };

  // Handle logging the session
  const handleLogSession = () => {
    const storedTimer = JSON.parse(localStorage.getItem(TIMER_KEY));
    if (!storedTimer) return;

    const now = new Date();
    const { startTime } = storedTimer;
    localStorage.removeItem(TIMER_KEY); // Clear timer state
    localStorage.removeItem(ACTIVE_TIMER_KEY); // Clear global active timer

    // Adjust end time based on user input (convert minutes back to seconds)
    const adjustedEndTime = new Date(new Date(startTime).getTime() + adjustedFocusTimeMinutes * 60 * 1000).toISOString();

    appendLog(goalId, startTime, adjustedEndTime)
      .then(() => alert(`Logged session for ${title}`))
      .catch((err) => console.error(err));

    resetState();
  };

  // Handle discarding the session
  const handleDiscardSession = () => {
    localStorage.removeItem(TIMER_KEY); // Clear timer state
    localStorage.removeItem(ACTIVE_TIMER_KEY); // Clear global active timer

    resetState();
  };

  // Reset state after handling modal actions
  const resetState = () => {
    setFocusTime(0); // Reset focus time
    setIsAnotherTimerActive(false); // Allow other timers to start
    setIsModalOpen(false); // Close modal
    setTooltipVisible(false); // Hide tooltip when modal closes
  };

  // Handle adjustment input change with validation
  const handleAdjustmentChange = (value) => {
    if (value > Math.floor(focusTime / 60)) {
      setTooltipVisible(true); // Show tooltip if value exceeds recorded time
      return;
    }
    
    setTooltipVisible(false); // Hide tooltip if value is valid
    setAdjustedFocusTimeMinutes(value);
  };

  return (
    <div className="goal-page-container">
      <Navbar />
      <header>
        <h1 className="goal-title">{title}</h1>
      </header>
      <div className="timer-display">
        <p>
          {String(Math.floor(focusTime / 60)).padStart(2, "0")}:
          {String(focusTime % 60).padStart(2, "0")}
        </p>
      </div>
      <div className="button-group">
        <button 
          onClick={startTimer} 
          disabled={!!timer || isAnotherTimerActive} 
          className="btn start-btn"
        >
          Start
        </button>
        <button onClick={stopTimer} disabled={!timer} className="btn stop-btn">
          Stop
        </button>
        <button onClick={() => router.push("/")} className="btn back-btn">
          Back to Goals
        </button>
      </div>
      {isAnotherTimerActive && (
        <p className="warning-message" style={{ textAlign: "center" }}>
          Another focus task is already running. Please stop it before starting a new one.
        </p>
      )}


      {/* Modal */}
      {isModalOpen && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>Log Notice</h2>
            <p>The recorded focus session duration was {Math.floor(focusTime / 3600)}h {Math.floor((focusTime % 3600) / 60)}m.</p>
            <div className="modal-buttons">
              <button onClick={handleLogSession} className="btn log-btn">Log Session</button>
              <button onClick={handleDiscardSession} className="btn discard-btn">Discard Session</button>
            </div>

            <hr className="modal-divider" />

            <div className="adjust-section">
                <p>or adjust the session duration (min)</p>
                <div className="adjust-controls">
                    <div className="input-container">
                    {tooltipVisible && (
                        <div className="tooltip-bubble">
                        Cannot exceed recorded time!
                        </div>
                    )}
                    <input 
                        type="number" 
                        value={adjustedFocusTimeMinutes} 
                        onChange={(e) => handleAdjustmentChange(Number(e.target.value))} 
                        className={`adjust-input ${tooltipVisible ? 'input-error' : ''}`}
                    />
                    </div>
                    <button 
                    onClick={handleLogSession} 
                    disabled={tooltipVisible} 
                    className="btn adjust-save-btn"
                    >
                    Adjust & Log
                    </button>
                </div>
            </div>
          </div>
        </div>      
      )}
    </div>
  );
}
