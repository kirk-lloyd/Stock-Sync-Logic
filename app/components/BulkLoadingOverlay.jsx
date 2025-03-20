import React, { useState, useEffect } from "react";
import { Spinner, Text, TextContainer, Button } from "@shopify/polaris";

/**
 * BulkLoadingOverlay Component
 * 
 * A specialized overlay for the bulk import operation that shows status information
 * and provides a "Refresh Now" button
 * 
 * @param {Object} props Component props
 * @param {Boolean} props.active Whether the overlay is currently active
 * @param {String} props.status The current status of the bulk operation
 * @param {Function} props.onRefresh Function to call when refresh button is clicked
 */
export function BulkLoadingOverlay({ active, status, onRefresh }) {
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);
  // Cambiado de 'entering' a 'idle' para evitar animaciones durante la hidratación
  const [animationState, setAnimationState] = useState('idle');
  // Estado para controlar renderizado cliente/servidor
  const [isClient, setIsClient] = useState(false);

  // Efecto para marcar cuando estamos en el cliente
  useEffect(() => {
    setIsClient(true);
  }, []);

  // Array of messages to display in the carousel
  const messages = [
    "We're importing your product catalogue. This process can take up to 10 minutes depending on your product count.",
    "Please be patient while we retrieve all your data.",
    "For stores with many products, this process may take longer. You can safely continue browsing other parts of the app.",
    "Your data is being downloaded and processed in the background. You'll see results as soon as they're ready.",
    "Large product catalogues with many variants may take several minutes to process completely."
  ];

  // Handle the message carousel animation - solo en el cliente
  useEffect(() => {
    if (!active || !isClient) return;

    // Iniciar con estado 'entering' una vez estamos en el cliente
    setAnimationState('entering');

    // Function to cycle through messages
    const cycleMessages = () => {
      // Start exit animation
      setAnimationState('exiting');
      
      // After exit animation completes, change the message and start entry animation
      setTimeout(() => {
        setCurrentMessageIndex((prevIndex) => (prevIndex + 1) % messages.length);
        setAnimationState('entering');
      }, 500); // 500ms for exit animation
    };

    // Set interval for message cycling
    const interval = setInterval(cycleMessages, 4000); // 4 seconds per message
    
    // Clean up interval on unmount or when inactive
    return () => clearInterval(interval);
  }, [active, messages.length, isClient]);

  // Don't render anything if not active
  if (!active) return null;
  
  return (
    <>
      <style>
        {`
          @keyframes fadeInUp {
            from {
              opacity: 0;
              transform: translateY(20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          
          @keyframes fadeOutUp {
            from {
              opacity: 1;
              transform: translateY(0);
            }
            to {
              opacity: 0;
              transform: translateY(-20px);
            }
          }
          
          .message-entering {
            animation: fadeInUp 0.5s ease forwards;
          }
          
          .message-exiting {
            animation: fadeOutUp 0.5s ease forwards;
          }
          
          .message-idle {
            opacity: 1;
            transform: translateY(0);
          }
          
          @keyframes pulse {
            0% {
              transform: scale(1);
              opacity: 1;
            }
            50% {
              transform: scale(1.05);
              opacity: 0.8;
            }
            100% {
              transform: scale(1);
              opacity: 1;
            }
          }
          
          .pulse-animation {
            animation: pulse 2s infinite ease-in-out;
          }
          
          .status-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 16px;
            background-color: #f9fafb;
            border: 1px solid #c4cdd5;
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 24px;
          }
          
          .status-created {
            background-color: #f4f6f8;
            border-color: #c4cdd5;
            color: #212b36;
          }
          
          .status-running {
            background-color: #eef9fc;
            border-color: #b4e1fa;
            color: #084e8a;
          }
          
          .refresh-button {
            margin-top: 24px;
            transition: transform 0.2s ease;
          }
          
          .refresh-button:hover {
            transform: scale(1.05);
          }
        `}
      </style>
    
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(255, 255, 255, 0.95)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          zIndex: 510,
          padding: "20px",
          textAlign: "center"
        }}
      >
        <div style={{ marginBottom: "30px" }} className={isClient ? "pulse-animation" : ""}>
          <Spinner accessibilityLabel="Loading" size="large" />
        </div>
        
        <div className={`status-badge status-${status.toLowerCase()}`}>
          Status: <b>{status}</b>
        </div>
        
        <TextContainer>
          <Text variant="headingLg" as="h2" fontWeight="bold">
            Importing Products
          </Text>
          
          <div style={{ 
            height: "110px", 
            display: "flex", 
            alignItems: "center", 
            justifyContent: "center",
            position: "relative",
            overflow: "hidden",
            margin: "20px 0"
          }}>
            <div 
              className={`message-${animationState}`}
              style={{ 
                maxWidth: "600px", 
                margin: "0 auto",
                position: "absolute"
              }}
            >
              <Text variant="bodyLg" as="p">
                {messages[currentMessageIndex]}
              </Text>
            </div>
          </div>
          
          <div style={{ 
            display: "flex", 
            justifyContent: "center", 
            marginTop: "15px",
            gap: "8px"
          }}>
            {messages.map((_, index) => (
              <div
                key={index}
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  backgroundColor: index === currentMessageIndex ? "#008060" : "#E0E0E0",
                  transition: "background-color 0.3s ease"
                }}
              />
            ))}
          </div>
          
          <div className="refresh-button">
            <Button primary onClick={onRefresh}>
              Check Status Now
            </Button>
          </div>
        </TextContainer>
      </div>
    </>
  );
}