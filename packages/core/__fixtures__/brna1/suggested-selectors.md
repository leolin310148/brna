# Snapshot · /checkout · iPhone 15 Pro
session: 00000000... · 2026-05-01T12:00:00.000Z

## screen
route: /checkout
title: Checkout

## tree
- screen#screen-checkout selectors=[@screen-checkout]
  - button#submit "Pay Now" → tap #submit selectors=[@submit, button:Pay Now]
  - region#form-address selectors=[@form-address]
    - button "Save" → tap button:Save in #form-address
  - region#form-payment selectors=[@form-payment]
    - button "Save" → tap button:Save in #form-payment
  - text selectors=[By...terms, By...agree...terms]
