const base = "https://api-v2.getcollectr.com";
const url = `${base}/data/showcase/hero-banner`;
fetch(url)
  .then(async (r) => {
    console.log("status", r.status);
    const t = await r.text();
    console.log(t.slice(0, 200));
  })
  .catch((e) => console.error(e));
