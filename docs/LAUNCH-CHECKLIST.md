# Notebook — Launch Checklist

## 1. Deploy the final version (if not already done)
- [ ] `notebook-final.zip` extract karo, poora `notebook/` folder GitHub repo
      ke ROOT mein upload karo (koi extra subfolder nahi)
- [ ] Vercel se connect/redeploy karo
- [ ] Deployment "Ready" status tak wait karo (Deployments tab mein)

## 2. Environment variables (Vercel → Settings → Environment Variables)
- [ ] `OPENROUTER_API_KEY` — set hai aur valid hai
- [ ] `NVIDIA_API_KEY` — set hai (fallback provider ke liye)
- [ ] `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — agar real
      rate-limiting chahiye (optional, but recommended before real launch)
- [ ] In sabko add karne ke baad ek baar **Redeploy** zaroor karo — env vars
      sirf naye deployment pe apply hote hain

## 3. Actual end-to-end test (khud karo, launch se pehle)
- [ ] Ek chhoti notes request try karo (jaise "Newton's laws simplify karo")
- [ ] Ek specimen paper try karo (jaise "ICSE class 10 physics 40 marks paper")
- [ ] PDF download try karo — khulti hai aur sahi dikhti hai confirm karo
- [ ] Sidebar khol/band karke dekho (mobile pe)
- [ ] Help & Feedback button test karo
- [ ] 3 baar generate karke dekho — 4th baar limit lagni chahiye

## 4. Share with real people (soft launch)
- [ ] 5-10 dost/classmates ko link bhejo
- [ ] Unse specifically bolo: "notes" aur "specimen paper" dono try karo
- [ ] Feedback panel se hi unse feedback maango (isse feature bhi test ho
      jayega)

## 5. Jo abhi ke liye chhod diya hai (yaad rakhna, feature nahi hai)
- Premium/payment abhi off hai (sab free hai) — jab guardian se paisa/top-up
  ho jaye, `docs/` mein likha hai kaise on karna hai
- Ads abhi off hain — jab AdSense account mile, `#adSlot` mein script paste
  karni hai
- Login/accounts nahi hain — sab kuch device-based hai abhi

## Agar koi error aaye
1. Vercel ke Deployments tab mein us deployment pe click karo
2. "Build Logs" ya "Runtime Logs" ka **exact text/screenshot** lo
3. Yahan wapas aakar bhejo — guessing ki jagah exact error se fix hoga
