/**
 * Helpers for reading GitHub issue comments (factory bot vs user feedback).
 */

const BOT_SIGNATURE =
  "*This is an automated response from the Matterbridge AI Plugin Factory*";

const SUCCESS_HEADINGS = [
  "## ✅ Plugin Ready for Testing",
  "## ✅ Plugin Updated",
];

const FIX_PUBLISHED_HEADING = "## ✅ Plugin Updated";

function isBotComment(comment) {
  return (comment?.body || "").includes(BOT_SIGNATURE);
}

function isSuccessComment(comment) {
  return (
    isBotComment(comment) &&
    SUCCESS_HEADINGS.some((heading) => comment.body.includes(heading))
  );
}

/**
 * Fetch all issue comments (paginated). Required for issues with hundreds of
 * bot spam comments — the default API page only returns the oldest 30.
 */
async function getIssueComments(octokit, owner, repo, issueNumber) {
  return octokit.paginate(octokit.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
}

/**
 * Find the latest human feedback posted after the last plugin-ready comment,
 * and not yet addressed by a "Plugin Updated" bot reply.
 */
function extractLatestFeedback(comments) {
  if (!comments?.length) return null;

  let lastSuccessIdx = -1;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (isSuccessComment(comments[i])) {
      lastSuccessIdx = i;
      break;
    }
  }

  let lastHuman = null;
  let lastHumanIdx = -1;
  for (let i = comments.length - 1; i > lastSuccessIdx; i--) {
    if (!isBotComment(comments[i])) {
      lastHuman = comments[i];
      lastHumanIdx = i;
      break;
    }
  }

  if (!lastHuman) return null;

  // Already fixed if the factory published an update after this feedback.
  for (let i = lastHumanIdx + 1; i < comments.length; i++) {
    const comment = comments[i];
    if (
      isBotComment(comment) &&
      comment.body.includes(FIX_PUBLISHED_HEADING)
    ) {
      return null;
    }
  }

  return {
    author: lastHuman.user.login,
    body: lastHuman.body,
    createdAt: lastHuman.created_at,
  };
}

module.exports = {
  BOT_SIGNATURE,
  isBotComment,
  isSuccessComment,
  getIssueComments,
  extractLatestFeedback,
};
