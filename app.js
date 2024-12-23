import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
const port = process.env.PORT || 4500;

// Shared environment variables
const apiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ELSEVIER_API_KEY = process.env.ELSEVIER_API_KEY;

app.use(express.json());

const processedMessages = new Set();
let userState = {}; // Store user interaction state

// Gemini title generation functions
async function generateTitles(topic) {
  if (!topic) {
    throw new Error("Topic is required");
  }

  const prompt = `I am planning to write a research paper. The keywords of the domain are "${topic}". Please generate 10 possible titles for my research paper. Only provide the titles in plain text, with no formatting (like bold, italics, or bullet points) but each topic with a numbering with each points have a gap in between.`;

  try {
    const result = await model.generateContent(prompt);
    const titles = result.response.text();
    return titles.trim();
  } catch (error) {
    console.error("Error with Gemini API:", error);
    throw new Error("Failed to generate titles");
  }
}


// Elsevier journal search functions
async function searchJournals(title) {
  const url = "https://api.elsevier.com/content/serial/title";
  const params = new URLSearchParams({
    title: title,
    apiKey: ELSEVIER_API_KEY,
    view: "STANDARD",
  });

  try {
    const response = await fetch(`${url}?${params}`, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    const data = await response.json();
    const journals = data["serial-metadata-response"].entry;

    return journals
      .map((journal) => ({
        title: journal["dc:title"] || "N/A",
        citeScore: journal.citeScoreYearInfoList?.citeScoreCurrentMetric || "N/A",
        scopusLink: journal.link.find((link) => link["@ref"] === "scopus-source")?.["@href"] || "N/A",
      }))
      .sort((a, b) => {
        if (a.citeScore === "N/A") return 1;
        if (b.citeScore === "N/A") return -1;
        return b.citeScore - a.citeScore;
      })
      .slice(0, 20);
  } catch (error) {
    console.error("Error searching journals:", error);
    throw error;
  }
}



// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});


// WhatsApp message sending functions
async function sendWhatsAppMessage(to, message) {  // For regular text messages
    const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    try {
      const MAX_MESSAGE_LENGTH = 4096;
    for (let i = 0; i < message.length; i += MAX_MESSAGE_LENGTH) {
      const chunk = message.slice(i, i + MAX_MESSAGE_LENGTH);
      const body = {
        messaging_product: "whatsapp",
        to: to,
        text: { body: chunk },
      };


      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

        if (!response.ok) {
            throw new Error(`WhatsApp API Error: ${response.status}`);
        }
    }


    } catch (error) {
        console.error('Error sending WhatsApp message:', error);
        throw error;
    }
}

async function sendWhatsAppMessageWithButtons(to, message, buttons) { // For messages with buttons
  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    const body = {
      messaging_product: "whatsapp",
      to: to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: message,
        },
        action: {
          buttons: buttons,
        },
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.error("WhatsApp API Error:", response.status, responseText);
      throw new Error(`WhatsApp API Error: ${response.status} - ${responseText}`);
    }

    const responseData = await response.json();
    console.log("WhatsApp API response:", responseData);


  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    throw error; 
  }
}




// Initial greeting with buttons
async function sendGreeting(phoneNumber) {
  const message = "Hello! Choose an option:";
  const buttons = [
    {
      type: "reply",
      reply: {
        id: "get_topics",
        title: "Topics",
      },
    },
    {
      type: "reply",
      reply: {
        id: "search_journals",
        title: "Search Journals",
      },
    },
  ];

  await sendWhatsAppMessageWithButtons(phoneNumber, message, buttons);
}



// Webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
  if (body.object) {
    if (
      body.entry &&
      body.entry[0] &&
      body.entry[0].changes &&
      body.entry[0].changes[0] &&
      body.entry[0].changes[0].value &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]
    ) {

      const messageData = body.entry[0].changes[0].value.messages[0];
      const phoneNumber = messageData.from;
      let message = "";
      if (messageData.text) {
        message = messageData.text.body;
      }
      const messageId = messageData.id;

      if (processedMessages.has(messageId)) {
        return res.status(200).send("Message already processed");
      }
      processedMessages.add(messageId);



      if (messageData.interactive) {  // Check for button clicks
        const buttonId = messageData.interactive.button_reply.id;

        if (buttonId === "get_topics") {
          userState[phoneNumber] = "waiting_for_topic";
          await sendWhatsAppMessage(phoneNumber, "Please enter the topic for your research paper:");
        } else if (buttonId === "search_journals") {
          userState[phoneNumber] = "waiting_for_journal_title";
          await sendWhatsAppMessage(phoneNumber, "Please enter the journal title to search for:");
        }

      } else if (userState[phoneNumber] === "waiting_for_topic") { // Gemini topic generation
        try {
          const titles = await generateTitles(message);
          await sendWhatsAppMessage(phoneNumber, titles);
          delete userState[phoneNumber];
        } catch (error) {
          console.error("Error generating titles", error);
          await sendWhatsAppMessage(
            phoneNumber,
            "Error processing your message. Please try again."
          );
          delete userState[phoneNumber];
        }


      } else if (userState[phoneNumber] === "waiting_for_journal_title") {  // Elsevier journal search
        try {
          const journals = await searchJournals(message);

          if (journals.length === 0) {
            await sendWhatsAppMessage(
              phoneNumber,
              "No journals found matching your search criteria."
            );
          } else {
            let responseMessage = `Top ${journals.length} journals matching "${message}":\n\n`;
            journals.forEach((journal, index) => {
              responseMessage += `${index + 1}. ${journal.title}\n`;
              responseMessage += `   CiteScore: ${journal.citeScore}\n`;
              responseMessage += `   Scopus: ${journal.scopusLink}\n\n`;
            });
            await sendWhatsAppMessage(phoneNumber, responseMessage);
          }
          delete userState[phoneNumber]; // Reset user state
        } catch (error) {
          console.error("Error searching for journals", error);
          await sendWhatsAppMessage(
            phoneNumber,
            "Error searching journals. Please try again."
          );
          delete userState[phoneNumber];
        }



      } else {
        // New user - Send the greeting
        if (!userState[phoneNumber]) {
          await sendGreeting(phoneNumber);
        }
      }



}
  }


    res.sendStatus(200);
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.sendStatus(500);
  }
});





app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});