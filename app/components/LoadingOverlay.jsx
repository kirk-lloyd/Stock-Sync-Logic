import React, { useState, useEffect } from "react";
import { Spinner, Text, TextContainer } from "@shopify/polaris";

/**
 * LoadingOverlay Component
 * 
 * A reusable component that creates a blurred overlay with loading indicator and message
 * Shows an animated carousel of messages that loop from bottom to top
 * 
 * @param {Object} props Component props
 * @param {Boolean} props.active Whether the overlay is currently active
 */
export function LoadingOverlay({ active }) {
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);
  const [animationState, setAnimationState] = useState('entering');

  // Array of messages to display in the carousel
  const messages = [
    "We're downloading all products from your store. This process can take up to 10 minutes depending on your product count.",
    "Our system is retrieving product details, variants, and inventory information from your Shopify store.",
    "You can close this display if you wish and return later when all your products have been loaded.",
    "For stores with many products, this process may take longer. Please be patient as we sync everything.",
    "Your data is being downloaded and processed in the background. You'll see results as soon as they're ready."
  ];

  // Handle the message carousel animation
  useEffect(() => {
    if (!active) return;

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
  }, [active, messages.length]);

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
        `}
      </style>
    
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(255, 255, 255, 0.85)",
          backdropFilter: "blur(4px)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          zIndex: 510,
          padding: "20px",
          textAlign: "center"
        }}
      >
        <div style={{ marginBottom: "30px" }} className="pulse-animation">
          <Spinner accessibilityLabel="Loading" size="large" />
        </div>
        
        <TextContainer>
          <Text variant="headingLg" as="h2" fontWeight="bold">
            Downloading Products
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
        </TextContainer>
      </div>
    </>
  );
}