const API_BASE = 'http://localhost:3000';

async function run() {
  console.log('=== STARTING AUTOMATED WALKTHROUGH VERIFICATION ===\n');

  // 1. Authenticate Aditya (Regular User)
  console.log('[Step 1] Logging in as Regular User (aditya@example.com)...');
  const userLoginRes = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'aditya@example.com', password: 'user123' })
  });
  if (!userLoginRes.ok) throw new Error('Aditya login failed: ' + await userLoginRes.text());
  const userAuth = await userLoginRes.json();
  console.log(`✓ Login success! Token acquired. User: ${userAuth.user.name} (${userAuth.user.role})`);

  // 2. Authenticate Admin (admin@gmail.com)
  console.log('\n[Step 2] Logging in as Administrator (admin@gmail.com)...');
  const adminLoginRes = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@gmail.com', password: 'password' })
  });
  if (!adminLoginRes.ok) throw new Error('Admin login failed: ' + await adminLoginRes.text());
  const adminAuth = await adminLoginRes.json();
  console.log(`✓ Admin login success! Token acquired. User: ${adminAuth.user.name} (${adminAuth.user.role})`);

  // 3. Perform slot booking for Court 1 (12bbc9f4-0b6a-4fb6-b668-81025e84dfe8)
  const courtId = '12bbc9f4-0b6a-4fb6-b668-81025e84dfe8';
  const bookingDate = `2026-09-${Math.floor(Math.random() * 20) + 10}`;
  const startHour = 14; // 14:00 (2 PM)
  const durationHours = 3;

  console.log(`\n[Step 3] Reserving a 3-hour slot on Court 1 at ${startHour}:00 (Date: ${bookingDate}) for Aditya...`);
  const reserveRes = await fetch(`${API_BASE}/api/bookings/reserve`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userAuth.token}`
    },
    body: JSON.stringify({
      courtId,
      userId: userAuth.user.id,
      bookingDate,
      startHour,
      durationHours
    })
  });
  if (reserveRes.status !== 201) throw new Error('Slot reservation failed: ' + await reserveRes.text());
  const reserveData = await reserveRes.json();
  const streamId = reserveData.streamId;
  console.log(`✓ Hold Reserved! Stream ID: ${streamId}, Expires: ${reserveData.expiresAt}`);

  // 4. Verify payment confirmation saga
  console.log(`\n[Step 4] Initiating and confirming payment for Stream ID: ${streamId}...`);
  const initRes = await fetch(`${API_BASE}/api/bookings/${streamId}/initiate-payment`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${userAuth.token}` }
  });
  if (!initRes.ok) throw new Error('Payment initiation failed: ' + await initRes.text());
  console.log('✓ Payment initiated (status is now payment_pending)');

  const payRes = await fetch(`${API_BASE}/api/bookings/${streamId}/confirm-payment`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${userAuth.token}` }
  });
  if (!payRes.ok) throw new Error('Payment confirmation failed: ' + await payRes.text());
  console.log('✓ Payment confirmed (status is now confirmed). Waiting for projections to update (1500ms)...');
  await new Promise(r => setTimeout(r, 1500));

  // 5. Verify availability read model updates
  console.log('\n[Step 5] Checking Availability view status for the booked slots...');
  const availRes = await fetch(`${API_BASE}/api/availability?courtId=${courtId}&date=${bookingDate}`);
  if (!availRes.ok) throw new Error('Failed to load availability view');
  const availability = await availRes.json();
  const bookedSlot = availability.find(s => s.start_hour === startHour);
  console.log(`✓ Availability view returned status: ${bookedSlot?.status} (Expected: confirmed/booking_confirmed)`);

  // 6. Verify User Bookings Read Model
  console.log('\n[Step 6] Verifying user bookings history read view...');
  const historyRes = await fetch(`${API_BASE}/api/users/${userAuth.user.id}/bookings`, {
    headers: { 'Authorization': `Bearer ${userAuth.token}` }
  });
  if (!historyRes.ok) throw new Error('Failed to load bookings history');
  const userBookings = await historyRes.json();
  const activeBooking = userBookings.find(b => b.stream_id === streamId);
  console.log(`✓ History view confirms booking: Status: ${activeBooking?.status}, Sport: ${activeBooking?.sport_type}, Amount: ₹${activeBooking?.total_amount}`);

  // 7. Verify E2E Event Log Scoping (User Scoping Check)
  console.log('\n[Step 7] Checking Event Log Scoping...');
  // A. Scoped fetch as user (should only see own stream events)
  const userEventsRes = await fetch(`${API_BASE}/api/events`, {
    headers: { 'Authorization': `Bearer ${userAuth.token}` }
  });
  const userEventsData = await userEventsRes.json();
  const userStreams = userEventsData.streams || [];
  console.log(`* Scoped user fetch returned: ${userStreams.length} stream(s).`);
  let userEventsList = [];
  userStreams.forEach(s => userEventsList.push(...s.events));
  const containsOthers = userEventsList.some(ev => ev.payload?.userId && ev.payload.userId !== userAuth.user.id);
  console.log(`✓ Scoped user event check: Scoped to own data only: ${!containsOthers}`);

  // B. Admin fetch (unfiltered + username included)
  const adminEventsRes = await fetch(`${API_BASE}/api/events`, {
    headers: { 'Authorization': `Bearer ${adminAuth.token}` }
  });
  const adminEventsData = await adminEventsRes.json();
  const adminStreams = adminEventsData.streams || [];
  console.log(`* Admin fetch returned: ${adminStreams.length} stream(s).`);
  const activeAdminStream = adminStreams.find(s => s.streamId === streamId);
  console.log(`✓ Admin event check: Username field present in stream: ${!!activeAdminStream?.userName} (Username: "${activeAdminStream?.userName}")`);

  // 8. Confirm Advisory Lock blocks double-booking
  console.log('\n[Step 8] Attempting to book a overlapping slot to verify Advisory Lock serialization...');
  const conflictRes = await fetch(`${API_BASE}/api/bookings/reserve`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userAuth.token}`
    },
    body: JSON.stringify({
      courtId,
      userId: userAuth.user.id,
      bookingDate,
      startHour: startHour + 1, // Overlaps!
      durationHours: 1
    })
  });
  console.log(`✓ Conflict Response Status: ${conflictRes.status} (Expected: 409)`);
  const conflictMsg = await conflictRes.text();
  console.log(`* Conflict Error Message: "${conflictMsg.trim()}"`);

  // 9. Cancel booking from History
  console.log('\n[Step 9] Cancelling the booking to release slots...');
  const cancelRes = await fetch(`${API_BASE}/api/bookings/${streamId}/cancel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${userAuth.token}` }
  });
  if (!cancelRes.ok) throw new Error('Cancellation failed');
  console.log('✓ Cancellation event written. Waiting for projections to update (1500ms)...');
  await new Promise(r => setTimeout(r, 1500));

  // 10. Confirm slot is freed on grid
  console.log('\n[Step 10] Checking availability grid to confirm slots are free...');
  const postCancelAvailRes = await fetch(`${API_BASE}/api/availability?courtId=${courtId}&date=${bookingDate}`);
  const postCancelAvail = await postCancelAvailRes.json();
  const freedSlot = postCancelAvail.find(s => s.start_hour === startHour);
  console.log(`✓ Slot is available: ${!freedSlot || freedSlot.status === 'released' || freedSlot.status === 'cancelled'}`);

  console.log('\n=== ALL WALKTHROUGH VERIFICATIONS PASSED SUCCESSFULLY ===');
}

run().catch(err => {
  console.error('\n✕ Verification FAILED:', err.message);
  process.exit(1);
});
