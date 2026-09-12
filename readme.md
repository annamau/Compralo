# Hackathon Product Brief: AI Buying Agent

## 1. The core idea

We want to build a consumer buying agent that lets a user define:

> **“Buy this product when my conditions are met.”**

Examples:

* Buy this PS5 when it is back in stock.
* Buy these shoes when they are available in size 44.
* Buy this GPU if the total price falls below €700.
* Buy this exact laptop from any approved retailer below €1,200.
* Buy this product within the next 30 days, but never above my maximum total price.

The user should not need to keep checking stock, price alerts, emails, or notifications.

The main product concept is:

> **Limit orders for everyday products.**

The user decides once. The system handles the timing.

---

# 2. The problem

Today, shopping automation is fragmented.

Users commonly:

1. Find something they want.
2. Discover it is unavailable or too expensive.
3. Set a stock or price notification.
4. Receive a notification later.
5. Return to the website.
6. Discover the product is already sold out again.

The notification does not actually solve the problem.

It simply tells the user:

> “You need to act right now.”

This particularly hurts people competing against:

* scalpers
* automated buyers
* limited-stock drops
* flash sales
* short-lived discounts

Our hypothesis is:

> **Normal shoppers should have access to the same ability to automate purchasing decisions once they have already decided what they want.**

We should be careful not to claim that the product itself eliminates scalping.

A stronger claim is:

> **We democratize access to buying automation.**

---

# 3. The key insight

Most AI shopping tools focus on:

> **What should I buy?**

Our product focuses on:

> **I already know what I want. Handle when I buy it.**

Traditional AI shopping:

```text
Need
↓
Search
↓
Recommendations
↓
Comparison
↓
Human returns
↓
Human purchases
```

Our model:

```text
Intent
↓
User defines conditions
↓
Agent monitors
↓
Conditions become true
↓
Agent acts
↓
User gets confirmation
```

The key concept is **persistent purchase intent**.

---

# 4. The product is bigger than a Chrome extension

The Chrome extension is likely the best hackathon interface.

But it is not the product itself.

The underlying product is:

> **A purchasing agent that receives and executes purchase instructions.**

Possible future interfaces:

* Chrome extension
* ChatGPT
* Grok
* WhatsApp
* mobile app
* website
* browser
* merchant checkout
* voice assistant

All of them create the same underlying object:

## Purchase Instruction

Example:

```text
Product:
PS5 Slim Digital 1TB

Quantity:
1

Condition:
New

Maximum total:
€450

Approved sellers:
Amazon
MediaMarkt
Fnac

Bundles:
Not allowed

Deadline:
30 days

Status:
MONITORING
```

The purchase instruction is the core abstraction.

---

# 5. Why the Chrome extension makes sense

The extension puts the agent exactly where the user's buying intent happens.

The user is already looking at the product.

Instead of:

1. Copying a URL.
2. Opening another app.
3. Explaining what they want.

They simply click:

> **AutoBuy**

The extension already has context.

This is particularly strong for the hackathon judging criteria because the agent exists **inside the environment where the task naturally happens**.

It is not simply a chatbot in another UI.

---

# 6. Proposed extension experience

The user lands on a product page.

They click the extension.

The extension understands the product and generates appropriate controls.

## Universal controls

These apply to almost every product:

```text
Maximum price
Deadline
Quantity
Condition
Approved retailers
Include delivery in max price?
Auto-buy enabled?
```

## AI-generated category-specific controls

This is one of the strongest AI features.

Instead of manually building interfaces for every type of product, AI understands the category and generates relevant purchasing parameters.

### PS5

```text
Edition:
[Digital] [Disc]

Bundles:
[Exact product only]
[Bundles allowed]

Condition:
[New]
[Refurbished]
```

### Shoes

```text
Size:
[44]

Color:
[Any]
[Black only]

Condition:
[New]
```

### GPU

```text
GPU:
RTX 5080

Manufacturer:
[Any]
[ASUS]
[MSI]

Condition:
[New]
```

### Laptop

```text
RAM:
16GB minimum

Storage:
1TB minimum

Color:
Any

Keyboard:
Spanish
```

This makes the interface dynamically adapt to the product being viewed.

---

# 7. The best AI architecture

We should NOT use AI for everything.

AI is:

* expensive
* slower
* probabilistic
* harder to debug
* inappropriate for enforcing money rules

Our principle should be:

> **AI handles ambiguity. Deterministic software handles money.**

## AI responsibilities

Use AI for:

### Product understanding

Understand:

* product type
* exact model
* edition
* variant
* specifications
* bundle contents
* condition

### Dynamic UI generation

Determine which purchasing controls matter for this product.

### Natural-language instructions

Example:

> “Buy this in any color except pink, new only, below €400.”

Convert that into structured rules.

### Cross-store product matching

Determine whether:

> “Sony PS5 Slim Digital Edition”

and

> “PlayStation 5 Slim Digital 1TB”

are actually the same product.

### Alternative discovery

Example:

> “The exact product is unavailable. The newer model is €12 more. Would you like to add it as an acceptable alternative?”

Different products should require approval.

---

# 8. Deterministic responsibilities

Once the user approves the purchase instruction, the LLM should mostly leave the critical path.

The system should check:

```text
Is the product available?

Does the exact variant match?

Is the total price <= max price?

Is the seller approved?

Is the product condition allowed?

Has the deadline expired?

Has this instruction already been fulfilled?

Is quantity still available?
```

Then:

```text
Acquire order lock
↓
Revalidate conditions
↓
Attempt checkout
↓
Verify merchant confirmation
↓
Mark purchase instruction fulfilled
↓
Disable remaining monitors
```

This should not depend on an LLM.

---

# 9. Stock monitoring

We found an open-source project that may save a lot of time:

## Streetmerchant

GitHub:

`jef/streetmerchant`

It is an open-source TypeScript/Node.js stock checker.

Useful functionality includes:

* continuous stock monitoring
* retailer-specific adapters
* product checking
* notifications
* dashboard
* some add-to-cart functionality

Importantly:

> Streetmerchant explicitly does NOT automatically complete purchases.

That is fine.

For us, Streetmerchant could become infrastructure for:

> **monitoring**

while our own system handles:

> **purchase instructions + decision engine + checkout**

Architecture:

```text
Chrome extension
↓
AI product understanding
↓
Purchase Instruction
↓
Monitoring service
Streetmerchant / retailer adapters
↓
Normalized stock event
↓
Purchase Rule Engine
↓
Execution Engine
↓
Payment + checkout
```

Streetmerchant should NOT be presented as our agent.

It is infrastructure.

---

# 10. Monitoring should return normalized events

We should convert retailer-specific results into something like:

```json
{
  "productId": "ps5-slim-digital-1tb",
  "retailer": "mediamarkt",
  "available": true,
  "price": 439.99,
  "shipping": 5.99,
  "total": 445.98,
  "condition": "new",
  "url": "..."
}
```

Then our deterministic system decides whether it qualifies.

---

# 11. Cross-store discovery

Another valuable feature:

When the user clicks AutoBuy, we can show:

```text
Current website:
Amazon
€449
Out of stock

Other matches:

MediaMarkt
€459
In stock

Fnac
€439
Out of stock

PcComponentes
€447
In stock
```

The user can then approve:

> Buy from any of these retailers below €450.

Important distinction:

### Same exact product

Can potentially be included in the same purchase instruction.

### Different or similar product

Requires additional approval.

AI can propose equivalence.

Deterministic product identifiers should be preferred when possible:

* EAN
* GTIN
* SKU
* UPC
* model number
* manufacturer identifier

AI should only resolve ambiguity when identifiers are insufficient.

---

# 12. AI cost strategy

AI should NOT run on every stock check.

Bad architecture:

```text
Check product
↓
Call LLM
↓
Check again
↓
Call LLM
↓
Repeat forever
```

Good architecture:

```text
First time seeing product
↓
Extract structured data
↓
Use AI if necessary
↓
Create canonical product representation
↓
Cache it
```

Then stock monitoring is cheap and deterministic.

AI can be called again only when:

* a new ambiguous listing appears
* a product variant cannot be classified
* a new category needs UI controls
* the user gives natural-language instructions

Potentially:

> one expensive AI call can support thousands of cheap deterministic checks.

---

# 13. Payment problem

This is one of the hardest real-world problems.

The desired experience is:

```text
User authorizes purchase now
↓
User leaves
↓
Product appears later
↓
Purchase completes without requiring the user to return
```

But real payment systems can require authentication such as:

* 3D Secure
* banking app confirmation
* SMS
* payment challenge

So:

> **Saving a card does not guarantee unattended checkout.**

---

# 14. Payment approaches explored

## Option A: Save payment method and charge later

User saves a payment method.

Later, when stock appears, the system attempts an off-session payment.

Pros:

* no money locked upfront
* clean UX
* standard payment architecture

Cons:

* payment may fail
* bank authentication may still be required
* user may need to come back

Likely best long-term default if supported appropriately.

---

## Option B: Temporary card authorization

When the user creates the purchase instruction:

> authorize €450

but do not capture immediately.

Later:

> capture when purchase succeeds

Pros:

* funds are temporarily reserved
* user demonstrated commitment
* good demo experience

Cons:

* authorization expires
* not suitable for long waiting periods
* exact expiration depends on payment method/network/provider

Very useful for the hackathon demo.

---

## Option C: Charge user upfront

User pays €450 immediately.

If product never becomes available:

> refund them.

Pros:

* money already collected
* strong purchasing commitment

Cons:

* refund costs
* poor user experience
* money may be locked unnecessarily
* regulatory/accounting complexity
* merchant payment is still a separate transaction

Probably not ideal.

---

## Option D: Pre-funded purchasing balance

User adds money to a balance first.

Agent spends from the balance later.

Conceptually attractive.

However:

> Pre-funding does NOT guarantee the retailer transaction will avoid authentication.

Funding and merchant checkout are separate payment events.

Still potentially useful long-term with the correct payment infrastructure.

---

## Option E: Virtual cards / scoped payment credentials

A payment provider issues a credential that can be limited by:

* amount
* merchant
* expiration
* use count

This fits the agent model extremely well.

Conceptually:

```text
User authorizes:
€450 for PS5 purchase

↓ 

Agent receives scoped purchasing credential

↓

Credential cannot exceed user mandate
```

Agentcard is one example we explored.

Their model is directionally very relevant to the future architecture.

However:

* current coverage and geography have limitations
* we should not depend on it for the hackathon
* virtual cards do not automatically eliminate every merchant authentication issue

---

# 15. Payment recommendation for the hackathon

Do NOT attempt to solve global autonomous payments today.

Build:

> **one controlled merchant + test payment workflow**

Ideal demo:

1. User creates buy instruction.
2. User authorizes test payment.
3. Instruction becomes ARMED.
4. User closes browser.
5. Stock changes.
6. Backend detects availability.
7. Rules are checked.
8. Test checkout executes.
9. Merchant confirms order.
10. User receives confirmation.

If authentication would be required:

```text
Status:
NEEDS YOUR ATTENTION
```

Do not fake universal payment automation.

---

# 16. Agentic behavior

We discussed whether checkout itself should be controlled by an AI browser agent.

Recommendation:

> **No, not for the hackathon.**

Avoid:

```text
LLM sees webpage
↓
LLM finds Buy button
↓
LLM fills checkout
↓
LLM guesses what to click next
```

This is:

* fragile
* unpredictable
* difficult to demo reliably
* dangerous around payments

Instead:

> AI handles product understanding and ambiguity.

Then:

> deterministic integrations handle checkout.

The overall product can still be legitimately agentic because it:

* receives a goal
* maintains state over time
* observes the environment
* evaluates changing conditions
* makes bounded decisions
* takes actions
* reports outcomes

An agent does not require an LLM to make every decision.

---

# 17. What makes the project genuinely agentic

The strongest demo should NOT simply be:

> Product becomes available → script buys it.

Instead:

Three offers appear.

### Offer 1

€430

But wrong PS5 edition.

Agent rejects.

### Offer 2

€445

Correct product.

But shipping adds €20.

Total €465.

User maximum is €450.

Agent rejects.

### Offer 3

€448 delivered.

Correct model.

Approved retailer.

Within deadline.

Agent approves execution.

The deterministic transaction engine purchases it.

That demonstrates:

> **understanding + persistent observation + bounded decision-making + autonomous action**

Much stronger than a stock monitor.

---

# 18. Anti-scalper positioning

Original motivation:

> Scalpers and automated buyers have an advantage over normal consumers.

Our mission could be:

> **Give normal consumers access to buying automation.**

Potential fairness rules:

* maximum quantity 1
* no bulk-purchase mode
* no paid queue jumping
* respect retailer restrictions
* prevent duplicate purchases
* possibly account-level limits

However:

Do NOT claim:

> “We solve scalping.”

Automation alone does not increase inventory.

A more accurate message:

> **“We level access to automation.”**

---

# 19. Existing competitors

The category is NOT completely new.

Relevant competitors and adjacent products include:

* HotStock AutoBuy
* ShopSavvy Auto-Buy
* Inventory Bot
* Rye
* Amazon automated shopping features
* Keepa / price trackers
* specialized purchasing bots
* retailer waitlists and price alerts

Important conclusion:

> **Do not pitch this as inventing automatic purchasing.**

Instead pitch the experience:

> **Make persistent buying instructions usable by ordinary consumers.**

The market currently appears fragmented across:

* price alerts
* stock alerts
* store-specific tools
* specialist bots
* retailer ecosystems
* partially automated checkout

Potential opportunity:

> turn this into one intuitive consumer interaction.

---

# 20. Strongest differentiation

Potential differentiation should come from the complete experience:

### 1. Product-page-native

The buying instruction starts exactly where intent happens.

### 2. Dynamic AI controls

Interface adapts to the product automatically.

### 3. Natural language

Users can say:

> “Buy this below €450, new only, no bundles.”

### 4. Cross-store search

Find exact matches across retailers.

### 5. Persistent instructions

User does not need to return when conditions change.

### 6. Bounded autonomous action

Agent can act only inside explicit user constraints.

### 7. Transparent decision history

Explain:

```text
Amazon rejected:
Out of stock

Store B rejected:
Wrong edition

Store C rejected:
€8 above maximum

MediaMarkt accepted:
€448 delivered
```

This builds trust.

---

# 21. Dashboard concept

Users should have an app/dashboard showing:

## Active

```text
PS5 Slim Digital
Maximum: €450
Expires: 22 days
Status: Monitoring
```

## Needs attention

```text
RTX 5080
Payment authentication required
```

## Purchased

```text
Air Jordan 1
Purchased: €174
Retailer: Foot Locker
```

## Expired

```text
MacBook Air
No qualifying offer found
```

---

# 22. Purchase instruction state machine

Possible statuses:

```text
DRAFT

↓ user approves

ACTIVE

↓ stock found

EVALUATING

↓

QUALIFIED
or
REJECTED OFFER

↓

EXECUTING

↓

PURCHASED
or
PAYMENT_REQUIRED
or
FAILED

↓

FULFILLED
```

Other states:

```text
CANCELLED
EXPIRED
MERCHANT_CANCELLED
```

A clear state machine will help technical reliability.

---

# 23. Duplicate protection

Important real-world problem:

Three retailers restock simultaneously.

Without proper locking:

> agent could accidentally purchase three PS5s.

Solution:

One purchase instruction should have one atomic execution lock.

Example:

```text
Offer A qualifies
Offer B qualifies
Offer C qualifies

↓

Execution engine obtains lock for Offer A

↓

B and C cannot execute
```

If checkout times out, verify whether the merchant actually created an order before retrying.

---

# 24. Spend safety

Users should be able to set:

```text
Maximum per order
Maximum total active exposure
Maximum purchases per day/month
Approved retailers
Approved product conditions
Expiry dates
```

The agent should never infer permission to spend beyond explicitly approved limits.

---

# 25. Hackathon judging rubric

The judging criteria provided were approximately:

## Core Requirements & Functionality

Does the project run end to end inside a place where people already live/work/talk?

Our target:

**4/5**

Potential 5 if extremely reliable.

---

## Innovation & Theme Alignment

Does the selected environment materially change what the agent can do?

Our strength:

The shopping webpage gives the agent:

* exact product context
* selected variant
* retailer
* price
* availability

This would be much more cumbersome in standalone chat.

Target:

**4/5**

Potential 5 if the dynamic contextual UI feels genuinely new.

---

## Technical Execution & Integration

Relevant engineering:

* extension
* page extraction
* AI structured output
* product matching
* monitoring
* state machine
* rule engine
* locking
* payment integration
* execution
* failure handling

Target:

**4/5**

Potential 5 if orchestration and failure states are demonstrated exceptionally well.

---

## Usefulness & Agentic Experience

The user benefit is immediately understandable.

Target:

**4–5/5**

This is likely the strongest category.

---

# 26. Estimated competitive hackathon score

Current concept:

> roughly **16/20**

Potential polished implementation:

> **17–18/20**

Potential ceiling with excellent demo:

> **18–19/20**

The biggest risks to the score are:

* demo breaks
* AI feels unnecessary
* checkout is obviously mocked
* product appears like only a stock tracker
* extension feels like a wrapper around ChatGPT

---

# 27. How to avoid looking like a ChatGPT wrapper

Do NOT make the demo:

> user chats → AI returns text.

Make it:

```text
User visits real product

↓

Extension understands page context automatically

↓

Relevant controls appear dynamically

↓

User defines purchasing mandate

↓

Browser closes

↓

Agent continues monitoring

↓

Multiple market events occur

↓

Agent rejects invalid offers

↓

Valid offer appears

↓

Transaction executes

↓

User receives result
```

The agent should visibly do work after the conversation is over.

---

# 28. Proposed hackathon MVP

## MUST HAVE

### Chrome extension

* detect current product
* capture page URL
* extract structured product data
* show AutoBuy interface

### AI product understanding

Generate:

* canonical product
* category
* variant attributes
* relevant UI filters

### Purchase instruction

Store:

* product
* maximum total
* deadline
* approved retailer(s)
* variant requirements
* quantity

### Monitoring

Either:

* adapt Streetmerchant

or:

* build a very narrow monitor for one test merchant

### Rule engine

Evaluate offers deterministically.

### Execution

At least one end-to-end controlled checkout.

### Dashboard

Show purchase instruction state.

---

# 29. SHOULD HAVE

If time allows:

* second product category
* another retailer
* alternative store discovery
* product match/rejection explanation
* price history
* natural-language order creation
* purchase logs
* browser notification

---

# 30. DO NOT BUILD TODAY

Avoid:

* universal retailer support
* production payments
* huge market analysis
* sponsorship system
* advertising marketplace
* social network
* complex price prediction
* reseller marketplace
* mobile apps
* merchant dashboard
* advanced anti-fraud
* sophisticated scalper detection

These can come later.

---

# 31. Recommended demo

## Scene 1

Open a PS5 product page.

It is:

> OUT OF STOCK

Click extension.

The extension detects:

```text
PS5 Slim
Digital Edition
1TB
```

AI dynamically shows:

```text
Edition
Condition
Bundles
Price limit
Deadline
Retailers
```

---

## Scene 2

User selects:

```text
Digital only
New
No bundles
Maximum total €450
Any approved retailer
30 days
```

Click:

> **Create Buy Order**

---

## Scene 3

Dashboard shows:

```text
PS5 Slim Digital

MONITORING
Maximum: €450
```

Close the browser.

This is important visually.

---

## Scene 4

Backend receives offers.

First:

```text
Store A
€430

Rejected:
Disc edition
```

Second:

```text
Store B
€445 + €15 shipping

Rejected:
Total €460
Maximum €450
```

Third:

```text
Store C
€448 delivered

Accepted
```

---

## Scene 5

Execution engine:

```text
Locking instruction...

Revalidating stock...

Verifying price...

Payment authorized...

Order confirmed.
```

Dashboard becomes:

> **PURCHASED €448**

---

# 32. The wow moment

The strongest moment is:

> **The browser is closed when the purchase happens.**

However, the real story is not just that it ran in the background.

The stronger story is:

> **The agent understood what the user meant, waited, evaluated changing opportunities and acted only when one satisfied the approved constraints.**

---

# 33. Suggested pitch

## Opening

> “When a product is out of stock, stores send you a notification when it comes back. But by the time you open that notification, it may already be gone.”

Then:

> “Why are humans still responsible for being online at exactly the right moment?”

---

## Product

> “We bring limit orders to everyday shopping.”

---

## How it works

> “Click AutoBuy directly on a product page. AI understands what you're looking at and creates the relevant buying controls. You define the price, variant, stores and deadline. Then you leave.”

---

## Agent behavior

> “The agent keeps watching. It evaluates new offers and buys only when one matches your exact mandate.”

---

## Architecture

> **“AI handles ambiguity. Deterministic software handles money.”**

This is one of the strongest technical phrases for the project.

---

## Vision

> “Today, AI helps you decide what to buy. We want AI to handle when you buy it.”

Or:

> **“You decide what to buy. We handle when to buy it.”**

---

# 34. Revenue ideas

Not essential for the hackathon.

Simplest model:

> **success fee per completed transaction**

Examples to explore later:

* flat €2–€5 successful purchase fee
* percentage with cap
* optional subscription for heavy users
* merchant referral commissions
* merchant integrations
* aggregated demand intelligence

For the hackathon:

> mention the transaction fee in one sentence.

Do not spend development time on monetization.

---

# 35. Longer-term product directions

If the concept works:

## Buy orders

```text
Buy under €X
```

## Stock orders

```text
Buy when available
```

## Multi-retailer orders

```text
Buy from any trusted retailer under €X
```

## Flexible variants

```text
Any of these colors
Any of these sizes
```

## Product alternatives

```text
Ask me before substituting
```

## Upgrade orders

```text
Upgrade my current device when the net cost falls below €X
```

## Bundled purchase instructions

```text
Buy these components only if the complete setup is under €X
```

---

# 36. Open product questions for the team

These are worth discussing before coding.

### UX

* Is AutoBuy the right name?
* Should it be called Buy Order?
* Should users see a maximum item price or maximum all-in total?
* How much configuration is too much?
* Do users trust an agent more if they see every rejected offer?

### AI

* Should controls come entirely from AI?
* Should we maintain templates for common categories?
* Should AI output JSON Schema?
* How do we cache generated schemas?
* How do we determine exact product equivalence?

### Monitoring

* Streetmerchant fork or custom monitor?
* Which retailer gives us the easiest reliable demonstration?
* Polling or controlled webhook?
* How often should we check?

### Payments

* Authorization/capture?
* Saved payment method?
* Fully simulated payment for hackathon?
* How do we demonstrate authentication-required fallback?

### Checkout

* Test merchant?
* Fake commerce environment?
* Existing sandbox API?
* How much of the checkout needs to be real to convince judges?

### Trust

* Which decisions require fresh user approval?
* How do users cancel?
* What if a merchant changes the price during checkout?
* What happens if shipping changes?
* How do we prove we purchased exactly once?

---

# 37. Decisions I would make now

If we need to move immediately:

## Product

**AI Buy Order Agent**

## Interface

**Chrome extension**

## Core message

**Limit orders for everyday products**

## AI role

**Understand products + dynamically generate constraints + resolve product matches**

## Rules

**Deterministic**

## Monitoring

**Reuse/adapt Streetmerchant where useful**

## Checkout

**One controlled supported merchant**

## Payment

**Test-mode authorization/payment flow**

## Demo products

**Two categories for AI adaptation**

but

**only one category/store needs full end-to-end execution**

## Demo requirement

**Browser must be closed before the qualifying offer appears**

---

# 38. What would make me change direction

We should pivot only if one of these happens today:

1. We cannot get monitoring reliably working.
2. We cannot demonstrate any credible checkout.
3. The extension cannot reliably understand product context.
4. We discover another team is building effectively the identical experience and is significantly ahead.
5. Payment/checkout dependencies make an end-to-end demo impossible.

Otherwise:

> **I would continue building this idea.**

---

# 39. Final product thesis

The most interesting version of the company is not:

> “A stock tracker.”

It is not:

> “An AI shopping chatbot.”

It is not:

> “A Chrome extension.”

The deeper product thesis is:

> **Consumers should be able to express persistent purchasing intent and delegate its execution to software.**

Today:

```text
“I want this.”
```

still requires:

```text
search
wait
monitor
respond
compare
checkout
```

The proposed product turns that into:

```text
“I want this under these conditions.”
```

And the agent handles the rest.

That is the idea the team should explore.

