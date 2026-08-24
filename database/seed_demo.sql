-- Optional demo data for v2.4.0.
-- No KPI or electricity demo data is included because those modules were removed.

INSERT INTO calendar_data(event_date,event_title,description)
VALUES ('2026-08-21','Daily Operations Review','Operations and management review');

INSERT INTO meeting_schedule(meeting_date,meeting_time,meeting_name,team,meeting_room,sort_order)
VALUES
('2026-08-21','09:30 AM','Daily Standup','Operations','Room 1',1),
('2026-08-21','11:00 AM','Management Review','Management','Room 2',2);

INSERT INTO department_schedule(schedule_date,department_name,start_time,end_time,location,sort_order)
VALUES ('2026-08-21','HR','01:00 PM','01:30 PM','Cafeteria',1);

INSERT INTO tasks_data(task_date,task_time,task_name,status,sort_order)
VALUES
('2026-08-21','10:30 AM','Follow up on open action items','Pending',1),
('2026-08-21','03:00 PM','Confirm staff travel plan','Pending',2);

INSERT INTO notes_data(note_date,note_title,note_description,sort_order)
VALUES
('2026-08-21','Daily Note','Review manpower status image and pending actions.',1);

INSERT INTO reminders_data(reminder_date,reminder_time,reminder_description,sort_order)
VALUES
('2026-08-21','11:00 AM','Management review',1),
('2026-08-21','04:30 PM','Finance follow up',2);
