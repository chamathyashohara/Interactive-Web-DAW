import { useEffect, useState } from "react";

function App() {
  const [message, setMessage] = useState("Connecting to server...");

  useEffect(() => {
    fetch("http://localhost:5000/api/health")
      .then((response) => response.json())
      .then((data) => {
        setMessage(data.message);
      })
      .catch(() => {
        setMessage("Could not connect to server.");
      });
  }, []);

  return (
    <div>
      <h1>Interactive Web DAW</h1>
      <p>{message}</p>
    </div>
  );
}

export default App;