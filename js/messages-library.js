/**
 * Predefined message library.
 * Organised into three categories; each entry is plain text the user can edit.
 *
 * Exposed on window.LeavingCard.library.
 */
(function (LC) {
"use strict";

const CATEGORIES = [
  { id: "goodluck", label: "Good Luck" },
  { id: "farewell", label: "Farewell & Good Luck" },
  { id: "funny", label: "Funny Congratulations" },
];

const LIBRARY = {
  goodluck: [
    "Best of luck on your first day! You’ve got this, and I am confident in your abilities.",
    "Wishing you smooth sailing and sunny skies as you embark on this new chapter of your career. May you find a career with endless possibilities.",
    "Sending you positive vibes and good luck charms for your new job adventure. Go knock ’em dead!",
    "Getting to know you these past few years has been an honour. Good luck with your new job.",
    "May each day bring new opportunities and exciting challenges. Good luck with your new job, you’re going to rock it!",
    "Remember, the sky’s the limit! Wishing you all the luck in the world as you soar to new heights in your career. Cheers to a new beginning!",
    "You don’t need luck because you worked hard for this, but good luck all the same.",
  ],
  farewell: [
    "Sad to see you go, but excited for what lies ahead! Wishing you all the best on your new journey. My warmest congratulations to you.",
    "Though we’ll miss your presence around the office, we’re thrilled to see you spread your wings and fly. Good luck with your new job!",
    "Farewell, dear friend! May your new job bring fulfilment, joy, and endless growth opportunities. Congrats on the job promotion.",
    "It’s been a pleasure working alongside you, and I have no doubt you’ll excel in your new role. Best of luck, and stay in touch!",
    "As you bid adieu to this chapter and turn the page to a new one, know that your hard work and dedication will continue to inspire us all. Good luck, and may success follow you wherever you go.",
  ],
  funny: [
    "Congrats on the new job! Now you can finally put all those years of job interview practice to good use.",
    "Who needs luck when you’ve got charm, wit, and a killer resume like yours? Congratulations on the new job!",
    "Just remember, the only thing more terrifying than a job interview is a first date. But hey, you’ve aced both now!",
    "Crossing my fingers that this new role comes with better coffee! Cheers to you and your success.",
    "It’s a wonder your boss hired you—were they dazzled by your charm or just desperate? Either way, congrats on landing the new gig.",
    "Treat a new job like a new love affair; it’ll end if you take it for granted. Wishing you all the success!",
    "Congratulations on the new job! Don’t forget to pack your sense of humour, you’ll need it for those Monday morning meetings.",
    "They say laughter is the best medicine, so here’s a healthy dose of congratulations on your new job. Break a leg! (But not literally, please.)",
  ],
};

/**
 * Return messages for a category, optionally filtered by a search term.
 * @param {string} categoryId
 * @param {string} [query]
 */
function searchLibrary(categoryId, query = "") {
  const list = LIBRARY[categoryId] || [];
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((m) => m.toLowerCase().includes(q));
}

LC.library = { CATEGORIES, LIBRARY, searchLibrary };
})(window.LeavingCard = window.LeavingCard || {});
